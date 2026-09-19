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
import { hasVerifier, captureBefore, verifyStep } from "./verify.js";
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

// Only a genuinely clean tree. "untracked files present" / "no changes added" go to the debugger (add + commit).
const NOTHING_TO_COMMIT = /nothing to commit, working tree clean/i;
const CD_INTENT = /\b(cd|chdir|change (the )?(folder|dir|directory)|go to|move to|switch to (the )?(folder|dir|directory)|open (the )?(folder|dir|directory|repo) )/i;
const isCommitCmd = (c) => Array.isArray(c) && c[0] === "git" && c[1] === "commit";

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
    if (c.internal === "sync_check") return "git fetch + compare branch with remote";
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
      const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
      if (same(target, state.cwd) || (snap.root && same(target, snap.root))) return { ok: true, exitCode: 0, stdout: "already here", stderr: "", ms: 0 };
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return { ok: false, exitCode: 1, stdout: "", stderr: `no such folder: ${target}`, ms: 0 };
      state.cwd = target;
      ui.onCwd?.(target);
      return { ok: true, exitCode: 0, stdout: `now in ${target}`, stderr: "", ms: 0 };
    }
    if (c.internal === "sync_check") return syncCheck(snap);
    return { ok: false, exitCode: 1, stdout: "", stderr: `unknown internal step ${c.internal}`, ms: 0 };
  }

  /** "Did it push?" answered by git, not by the model. */
  async function syncCheck(snap) {
    const done = (text) => ({ ok: true, exitCode: 0, stdout: text, stderr: "", ms: 0 });
    if (!snap.isRepo) return done("✖ No — this folder is not a git repository.");
    if (!snap.hasCommits) return done("✖ No — there are no commits yet, so nothing has been pushed.");
    const remote = snap.upstreamRemote || snap.defaultRemote;
    if (!remote) return done("✖ No — this repo has no remote. Nothing can have been pushed.");
    const f = await run(["git", "fetch", remote], { cwd: state.cwd, color: false, timeoutMs: 30_000 });
    if (!f.ok) return { ok: false, exitCode: 1, stdout: "", stderr: `couldn't reach ${remote}: ${firstLine(f.stderr)}`, ms: 0 };
    const s = await snapshot(state.cwd);
    const url = s.remoteUrls[remote];
    if (!s.upstream) {
      const onRemote = s.remoteBranches.includes(`${remote}/${s.branch}`);
      return done(onRemote ? `⚠ ${s.branch} exists on ${remote} (${url}) but isn't tracked. Say "push" to link and sync it.` : `✖ No — branch ${s.branch} is NOT on ${remote} (${url}). Say "push" to publish it.`);
    }
    if (!s.ahead && !s.behind) return done(`✔ Yes — ${s.branch} is on ${remote} (${url}) and fully in sync.`);
    const parts = [s.ahead && `${s.ahead} local commit(s) NOT pushed yet`, s.behind && `${s.behind} remote commit(s) not pulled`].filter(Boolean);
    return done(`${s.ahead ? "✖ Not fully" : "✔ Pushed, but"} — ${s.branch} vs ${s.upstream}: ${parts.join(", ")}.`);
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
    const verified = [];
    const unverified = [];
    for (let i = 0; i < steps.length; i++) {
      if (signal.aborted) return { ok: false, outputs, verified, unverified };
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
        return { ok: false, outputs, verified, unverified };
      }
      const before = hasVerifier(step.op.id) ? await captureBefore(state.cwd, snap) : null;
      const stepOutput = [];
      let skipped = false;
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
        // "nothing to commit" is not a failure of the request — skip it and keep going,
        // otherwise a plan like [add, commit, push] never reaches the push.
        if (!res.ok && isCommitCmd(c) && NOTHING_TO_COMMIT.test(stripAnsi(text))) {
          ui.emit({ type: "note", tone: "muted", text: "Nothing new to commit — skipping the commit and continuing." });
          outputs.push({ command: label, ok: true, output: "nothing to commit" });
          skipped = true;
          continue;
        }
        ui.emit({ type: "cmd", command: label, ok: res.ok, output: text, ms: res.ms });
        outputs.push({ command: label, ok: res.ok, output: text });
        stepOutput.push(text);
        // Failed command, but is the goal state already true? (e.g. deleting a branch
        // that the PR merge already deleted). Decided by the real state, never assumed.
        if (!res.ok && before && cmds.length === 1 && !signal.aborted) {
          const v = await verifyStep(step, before, state.cwd, { output: text, builtName: c[3], pushed: c.includes?.("--push") });
          if (v.ok === true) {
            ui.emit({ type: "verify", ok: true, text: `already the case — ${v.text}` });
            verified.push(v.text);
            outputs.push({ command: `verify ${step.op.id}`, ok: true, output: v.text });
            skipped = true;
            break;
          }
        }
        if (!res.ok) {
          if (signal.aborted) return { ok: false, outputs, verified, unverified };
          const fix = await debug({ request, command: label, argv: c.internal ? [] : c, output: stripAnsi(text), failed: step, rest: steps.slice(i + 1), depth, signal });
          const fixed = !!fix?.ok;
          outputs.push({ command: "auto-fix + retry", ok: fixed, output: fixed ? "fix applied, remaining steps ran" : "not fixed" });
          return {
            ok: fixed,
            outputs,
            verified: [...verified, ...(fix?.verified || [])],
            unverified: [...unverified, ...(fix?.unverified || [])],
            failedAt: fix?.failedAt || label,
            notRun: fixed ? [] : steps.slice(i + 1).map((s) => s.op.id),
          };
        }
      }
      // Exit code 0 is not proof. Check the real state (local refs, the remote, GitHub).
      if (before && !skipped) {
        ui.status(`Verifying ${step.op.id} against the real repo…`);
        const last = cmds.at(-1) || [];
        const v = await verifyStep(step, before, state.cwd, {
          output: stepOutput.join("\n"),
          builtName: step.op.id === "gh_repo_create" ? last[3] : undefined,
          pushed: Array.isArray(last) && last.includes("--push"),
        });
        ui.emit({ type: "verify", ok: v.ok, text: v.text });
        outputs.push({ command: `verify ${step.op.id}`, ok: v.ok === true, output: v.text });
        if (v.ok === false) return { ok: false, outputs, verified, unverified, failedAt: `${step.op.id} (verification: ${v.text})`, notRun: steps.slice(i + 1).map((s) => s.op.id) };
        (v.ok ? verified : unverified).push(v.text);
      }
      afterStep(step, snap);
    }
    return { ok: true, outputs, verified, unverified };
  }

  function afterStep(step, snap) {
    if (step.op.id === "gh_switch_account" || step.op.id === "gh_login") resetGhCache();
    if (step.op.id === "clone" || step.op.id === "gh_repo_clone") {
      const src = step.args.url || step.args.repo || "";
      const dir = step.args.dir || src.split(/[\\/:]/).pop().replace(/\.git$/, "");
      if (dir) ui.emit({ type: "note", tone: "info", text: `Cloned into ./${dir} — say "cd ${dir}" or /cd ${dir} to work in it.` });
    }
  }

  /** Diagnose a failure and (after confirmation) run a fix. Returns the fix run result, or null if no fix ran. */
  async function debug({ request, command, argv, output, failed, rest, depth, signal }) {
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
    }
    ui.emit({ type: "diagnosis", text: cause || "The command failed (see output above)." });
    let steps = (raw || []).map((s) => resolveStep(s)).filter((s) => !s.error);
    // Re-running the exact step that just failed, unchanged, is a loop, not a fix.
    const sig = (s) => `${s.op.id}${JSON.stringify(s.args)}`;
    if (failed && !(known && known.steps !== null) && steps.length && sig(steps[0]) === sig(failed)) steps = steps.slice(1);
    if (!steps.length || depth >= MAX_FIX_DEPTH || signal.aborted) return null;
    if (known && known.steps !== null) {
      // A known fix repairs the cause; the step that failed (and everything after it)
      // still has to run, e.g. "no commits yet" -> add + commit, THEN the push again.
      const tail = [failed, ...rest].filter((s) => s && !steps.some((f) => f.op.id === s.op.id));
      steps = [...steps, ...tail];
    }
    const r = await execute(steps, { request, depth: depth + 1, signal, isFix: true });
    return r;
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
      // Hard guard: a folder change the user didn't ask for would run everything else in the wrong repo.
      if (!route && plan.steps.some((s) => s.op.id === "cd") && !CD_INTENT.test(request)) {
        plan.steps = plan.steps.filter((s) => s.op.id !== "cd");
      }
      if (plan.reply || plan.ask) ui.emit({ type: "agent", text: plan.ask || plan.reply, ask: !!plan.ask, meta: plan.meta });
      if (plan.dropped?.length) ui.emit({ type: "note", tone: "warn", text: `Ignored invalid step(s): ${plan.dropped.join("; ")}` });
      if (plan.ask || !plan.steps.length) {
        remember(request, [], plan.ask || plan.reply);
        return;
      }
      if (plan.steps.some((s) => s.op.id === "sync_check")) plan.explain = false; // its answer is exact already
      const result = await execute(plan.steps, { request, signal });
      if (result.ok && plan.explain && !signal.aborted) await explain(request, result.outputs, signal);
      // The model's reply is a plan, not proof. Only verified state earns "done".
      if (!result.ok && !result.cancelled && !signal.aborted) {
        const skipped = result.notRun?.length ? ` Not run: ${result.notRun.join(", ")}.` : "";
        ui.emit({ type: "summary", ok: false, text: `Request NOT completed — stopped at \`${result.failedAt || "a failed step"}\`.${skipped}` });
      } else if (result.ok && result.unverified?.length) {
        ui.emit({ type: "summary", ok: null, text: `Commands ran, but I could NOT confirm: ${result.unverified.join("; ")}. Don't treat this as done.` });
      } else if (result.ok && result.verified?.length) {
        ui.emit({ type: "summary", ok: true, text: `Done — verified ${result.verified.length} change(s) against the real repo.` });
      }
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
