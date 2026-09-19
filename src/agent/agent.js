import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { resolveStep, buildCommands } from "../catalog/index.js";
import { classifyRaw } from "../catalog/risk.js";
import { run, runInteractive, fmt, splitArgs } from "../exec/run.js";
import { chat, extractJson } from "../llm/index.js";
import { snapshot, contextText, resetGhCache } from "./context.js";
import { fastRoute } from "./router.js";
import { matchKnownError } from "./knownErrors.js";
import { diffFor, writeCommitMessage } from "./commitMessage.js";
import { SYSTEM_PROMPT, slimSystemPrompt, planMessage, debugMessage, EXPLAIN_SYSTEM } from "./prompt.js";

const RISK_RANK = { read: 0, write: 1, danger: 2 };
const MAX_FIX_DEPTH = 2;

// No JSON schema is sent to Ollama on purpose: with a schema Ollama emits keys
// alphabetically ("ask" first), which primes the model to ask instead of act.
// Plain JSON mode + resolveStep validation + one repair round works better.

// Raw commands that need a real terminal (editor, prompts, browser login).
const NEEDS_TTY = [/^git (rebase|add|checkout|reset|restore|stash)\b.*\s(-i|-p|--interactive|--patch)\b/, /^git commit(?!.*\s(-m|-F|--message|--file|--no-edit|-C)\b)/, /^gh auth login(?!.*--with-token)/, /^git mergetool\b/, /^git difftool\b/];

function rawStep(command) {
  const argv = splitArgs(command);
  const line = argv.join(" ");
  const interactive = NEEDS_TTY.some((r) => r.test(line));
  return { op: { id: "raw", interactive, build: () => [argv] }, args: {}, risk: classifyRaw(argv), warn: "" };
}

// Windows autocrlf chatter adds nothing and buries real output.
const NOISE = /^(warning: )?in the working copy of '.*', (LF|CRLF) will be replaced by (CRLF|LF).*$/;
const cleanOutput = (s) =>
  s
    .split(/\r?\n/)
    .filter((l) => !NOISE.test(stripAnsi(l)))
    .join("\n")
    .trim();

/** Small models sometimes split one op across two steps (pull{branch} pull{rebase}). Merge consecutive duplicates. */
function mergeDuplicates(steps) {
  const out = [];
  for (const s of steps) {
    const prev = out.at(-1);
    if (prev && !prev.error && !s.error && prev.op.id === s.op.id && !["add", "commit", "cherry_pick", "git_raw", "gh_raw"].includes(s.op.id)) {
      out[out.length - 1] = resolveStep({ op: s.op.id, args: { ...prev.args, ...s.args } });
    } else out.push(s);
  }
  return out;
}

const firstLine = (s) => stripAnsi(s || "").trim().split(/\r?\n/).find(Boolean) || "";

/**
 * UI-agnostic agent. `ui` implements:
 *   status(text|null)           spinner line ("Thinking…", "Running git push…")
 *   emit(item)                  append to transcript
 *   confirm({title, commands, risk, warn}) -> Promise<boolean>
 *   interactive(fn) -> Promise   hand the terminal to a child process
 *   onCwd?(cwd)                 working folder changed
 */
export function createAgent({ settings, cwd, ui, llm = chat }) {
  const state = { cwd, turns: [], controller: null, tokens: { prompt: 0, completion: 0, calls: 0 } };

  const track = (r) => {
    state.tokens.calls++;
    state.tokens.prompt += r?.usage?.prompt_tokens || 0;
    state.tokens.completion += r?.usage?.completion_tokens || 0;
  };

  async function askModel(userContent, signal, hint = userContent) {
    const extra = [];
    const messages = (provider) => [
      { role: "system", content: provider === "groq" ? slimSystemPrompt(hint) : SYSTEM_PROMPT },
      { role: "user", content: userContent },
      ...extra,
    ];
    let r = await llm(settings, messages, { json: true, signal, maxTokens: 800 });
    track(r);
    let parsed;
    let problem = "";
    try {
      parsed = extractJson(r.text);
    } catch (e) {
      problem = `Your reply was not valid JSON (${e.message}).`;
    }
    const check = (p) => (p?.steps || []).map((s) => resolveStep(s)).filter((s) => s.error).map((s) => s.error);
    if (!problem && check(parsed).length) problem = `Invalid steps: ${check(parsed).join("; ")}. Use only catalog op ids and required args.`;
    if (problem) {
      // one repair round: small models usually fix it when told exactly what's wrong
      extra.push({ role: "assistant", content: r.text || "{}" }, { role: "user", content: `${problem} Reply again with the corrected JSON object only.` });
      r = await llm(settings, messages, { json: true, signal, maxTokens: 800 });
      track(r);
      parsed = extractJson(r.text);
    }
    const resolved = mergeDuplicates((parsed.steps || []).map((s) => resolveStep(s)));
    const good = resolved.filter((s) => !s.error);
    return {
      reply: String(parsed.reply || "").trim(),
      // a question next to a runnable plan is the model being timid — risky steps get our own confirm
      ask: good.length ? "" : String(parsed.ask || "").trim(),
      explain: !!parsed.explain,
      steps: good,
      dropped: resolved.filter((s) => s.error).map((s) => s.error),
      meta: { provider: r.provider, model: r.model, ms: r.ms },
    };
  }

  function needsConfirm(steps, isFix) {
    const max = Math.max(...steps.map((s) => RISK_RANK[s.risk] ?? 1));
    if (settings.mode === "yolo") return false;
    if (isFix || settings.mode === "confirm") return max >= 1;
    return max >= 2;
  }

  function preview(steps, snap) {
    const lines = [];
    for (const s of steps) {
      try {
        const args = s.op.autoMessage && !s.args.message && !s.args.amend ? { ...s.args, message: "‹message written from your diff›" } : s.args;
        for (const c of s.op.build(args, { cwd: state.cwd, snap })) lines.push(c.internal ? describeInternal(c) : fmt(c));
      } catch {
        lines.push(s.op.id);
      }
    }
    return lines;
  }

  function describeInternal(c) {
    if (c.internal === "gitignore") return `edit .gitignore  (+ ${c.patterns.join(", ")})`;
    if (c.internal === "cd") return `cd ${c.path}`;
    return c.internal;
  }

  async function runInternal(c, snap) {
    if (c.internal === "gitignore") {
      const file = path.join(snap.root || state.cwd, ".gitignore");
      const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
      const add = c.patterns.filter((p) => !have.has(p));
      if (add.length) fs.writeFileSync(file, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + add.join("\n") + "\n");
      return { ok: true, exitCode: 0, stdout: add.length ? `added: ${add.join(", ")}` : "already ignored", stderr: "", ms: 0 };
    }
    if (c.internal === "cd") {
      const target = path.resolve(state.cwd, c.path.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE || process.env.HOME || "~"));
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return { ok: false, exitCode: 1, stdout: "", stderr: `no such folder: ${target}`, ms: 0 };
      state.cwd = target;
      ui.onCwd?.(target);
      return { ok: true, exitCode: 0, stdout: `now in ${target}`, stderr: "", ms: 0 };
    }
    return { ok: false, exitCode: 1, stdout: "", stderr: `unknown internal step ${c.internal}`, ms: 0 };
  }

  /** Run resolved steps in order. Stops at the first failure and hands it to the debugger. */
  async function execute(steps, { request, depth = 0, signal, isFix = false }) {
    let snap = await snapshot(state.cwd);
    if (needsConfirm(steps, isFix)) {
      const risk = steps.reduce((m, s) => (RISK_RANK[s.risk] > RISK_RANK[m] ? s.risk : m), "read");
      const warn = [...new Set(steps.map((s) => s.warn).filter(Boolean))].join(" ");
      ui.status(null);
      const ok = await ui.confirm({ title: isFix ? "Apply this fix?" : "Run these commands?", commands: preview(steps, snap), risk, warn });
      if (!ok) {
        ui.emit({ type: "note", tone: "muted", text: "Skipped — nothing was run." });
        return { ok: false, outputs: [], cancelled: true };
      }
    }
    const outputs = [];
    for (let i = 0; i < steps.length; i++) {
      if (signal.aborted) return { ok: false, outputs };
      const step = steps[i];
      if (i > 0) snap = await snapshot(state.cwd);
      const needsMsg = step.op.autoMessage && !step.args.message && !step.args.amend;
      if (needsMsg) {
        if (step.op.id === "commit" && !snap.staged.length && !step.args.all && !step.args.allow_empty) {
          if (snap.unstaged.length || snap.untracked.length) {
            ui.emit({ type: "note", tone: "muted", text: "Nothing staged yet — staging all changes first." });
            const r = await run(["git", "add", "-A"], { cwd: state.cwd, signal });
            ui.emit({ type: "cmd", command: "git add -A", ok: r.ok, output: r.stdout || r.stderr, ms: r.ms });
            snap = await snapshot(state.cwd);
          }
        }
        ui.status("Writing commit message from your diff…");
        const diff = await diffFor(step.op, step.args, state.cwd);
        if (diff) {
          const { message, usage } = await writeCommitMessage(settings, diff, state.cwd, signal, llm);
          if (usage) track(usage);
          step.args = { ...step.args, message };
          ui.emit({ type: "commitmsg", text: message });
        } else if (step.op.id === "squash_last") {
          step.args = { ...step.args, message: "squash commits" };
        }
      }
      let cmds;
      try {
        cmds = buildCommands(step, { cwd: state.cwd, snap });
      } catch (e) {
        ui.emit({ type: "note", tone: "error", text: `Couldn't build ${step.op.id}: ${e.message}` });
        return { ok: false, outputs };
      }
      for (const c of cmds) {
        let res;
        let label;
        if (c.internal) {
          label = describeInternal(c);
          res = await runInternal(c, snap);
        } else if (step.op.interactive) {
          label = fmt(c);
          ui.emit({ type: "note", tone: "info", text: `Handing the terminal to: ${label}` });
          res = await ui.interactive(() => runInteractive(c, { cwd: state.cwd }));
        } else {
          label = fmt(c);
          ui.status(`Running ${label.length > 60 ? label.slice(0, 57) + "…" : label}`);
          res = await run(c, { cwd: state.cwd, signal });
          // read-only commands exit 1 for "no matches" (git grep, diff --exit-code) — not a failure
          if (!res.ok && step.risk === "read" && res.exitCode === 1 && !res.stderr.trim()) res = { ...res, ok: true };
        }
        const text = cleanOutput([res.stdout, res.stderr].filter((t) => t && t.trim()).join("\n"));
        ui.emit({ type: "cmd", command: label, ok: res.ok, output: text, ms: res.ms });
        outputs.push({ command: label, ok: res.ok, output: text });
        if (!res.ok) {
          if (signal.aborted) return { ok: false, outputs };
          await debug({ request, command: label, argv: c.internal ? [] : c, output: stripAnsi(text), rest: steps.slice(i + 1), depth, signal });
          return { ok: false, outputs };
        }
      }
      afterStep(step, snap);
    }
    return { ok: true, outputs };
  }

  function afterStep(step, snap) {
    if (step.op.id === "gh_switch_account" || step.op.id === "gh_login") resetGhCache();
    if (step.op.id === "clone" || step.op.id === "gh_repo_clone") {
      const src = step.args.url || step.args.repo || "";
      const dir = step.args.dir || src.split(/[\\/:]/).pop().replace(/\.git$/, "");
      if (dir) ui.emit({ type: "note", tone: "info", text: `Cloned into ./${dir} — say "cd ${dir}" or /cd ${dir} to work in it.` });
    }
  }

  async function debug({ request, command, argv, output, rest, depth, signal }) {
    ui.status("Diagnosing the failure…");
    const snap = await snapshot(state.cwd);
    const known = matchKnownError(output, snap, argv);
    let cause = known?.cause || "";
    let raw = known?.steps;
    if (!known || known.steps === null) {
      try {
        const turns = state.turns.slice(-3);
        const remaining = rest.length ? `\nSteps that did not run yet (include them after the fix if still needed): ${rest.map((s) => `${s.op.id}(${JSON.stringify(s.args)})`).join(", ")}` : "";
        const plan = await askModel(debugMessage({ request, context: contextText(snap), command, output: output + remaining, turns }), signal, `${request} ${command} ${output.slice(0, 300)}`);
        cause = [known?.cause, plan.reply].filter(Boolean).join(" ");
        raw = plan.steps.map((s) => ({ op: s.op.id, args: s.args }));
      } catch (e) {
        cause = cause || `Couldn't diagnose automatically (${e.message}).`;
        raw = [];
      }
    } else if (rest.length && raw?.length) {
      raw = [...raw, ...rest.filter((r) => !raw.some((k) => k.op === r.op.id)).map((s) => ({ op: s.op.id, args: s.args }))];
    }
    ui.emit({ type: "diagnosis", text: cause || "The command failed (see output above)." });
    const steps = (raw || []).map((s) => resolveStep(s)).filter((s) => !s.error);
    if (!steps.length || depth >= MAX_FIX_DEPTH || signal.aborted) return;
    await execute(steps, { request, depth: depth + 1, signal, isFix: true });
  }

  async function explain(question, outputs, signal) {
    const text = outputs.map((o) => `$ ${o.command}\n${stripAnsi(o.output).slice(0, 3000)}`).join("\n\n").slice(0, 7000);
    if (!text.trim()) return;
    ui.status("Reading the output…");
    const r = await llm(settings, [
      { role: "system", content: EXPLAIN_SYSTEM },
      { role: "user", content: `Question: ${question}\n\nCommand output:\n${text}` },
    ], { maxTokens: 400, signal });
    track(r);
    ui.emit({ type: "answer", text: r.text.trim() });
  }

  function remember(request, outputs, reply) {
    const ran = outputs.map((o) => `${o.command} ${o.ok ? "(ok)" : `(FAILED: ${firstLine(o.output).slice(0, 80)})`}`).join("; ");
    state.turns.push(`user: ${request} -> ${ran ? `ran: ${ran}` : `answered: ${reply.slice(0, 120)}`}`);
    if (state.turns.length > 6) state.turns.shift();
  }

  async function handle(input) {
    const request = input.trim();
    if (!request) return;
    const controller = new AbortController();
    state.controller = controller;
    const { signal } = controller;
    try {
      ui.status("Reading repo…");
      const snap = await snapshot(state.cwd);
      const route = fastRoute(request, snap);
      let plan;
      if (route?.kind === "raw") {
        plan = { reply: "", steps: [rawStep(route.command)], explain: false, ask: "", meta: { fast: true } };
      } else if (route?.kind === "steps") {
        plan = { reply: "", steps: route.steps.map((s) => resolveStep(s)).filter((s) => !s.error), explain: false, ask: "", meta: { fast: true } };
      } else {
        ui.status("Thinking…");
        plan = await askModel(planMessage({ request, context: contextText(snap), turns: state.turns.slice(-4) }), signal, request);
      }
      if (signal.aborted) return;
      if (plan.reply || plan.ask) ui.emit({ type: "agent", text: plan.ask || plan.reply, ask: !!plan.ask, meta: plan.meta });
      if (plan.dropped?.length) ui.emit({ type: "note", tone: "warn", text: `Ignored invalid step(s): ${plan.dropped.join("; ")}` });
      if (plan.ask || !plan.steps.length) {
        remember(request, [], plan.ask || plan.reply);
        return;
      }
      const result = await execute(plan.steps, { request, signal });
      if (result.ok && plan.explain && !signal.aborted) await explain(request, result.outputs, signal);
      remember(request, result.outputs, plan.reply);
    } catch (e) {
      if (!signal.aborted) ui.emit({ type: "note", tone: "error", text: e.message });
    } finally {
      ui.status(null);
      if (state.controller === controller) state.controller = null;
    }
  }

  return {
    handle,
    /** Planner only (no execution) — used by the eval script. */
    plan: (request, context, turns = []) => askModel(planMessage({ request, context, turns }), new AbortController().signal, request),
    cancel: () => state.controller?.abort(),
    get busy() {
      return !!state.controller;
    },
    get cwd() {
      return state.cwd;
    },
    setCwd(c) {
      state.cwd = c;
    },
    state,
  };
}
