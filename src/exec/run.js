import { execa } from "execa";

// Environment for every child git/gh process. The goal: never block on a
// prompt the TUI can't show (editor, pager, credential prompt), and keep
// colors in output so results look like real git.
const CHILD_ENV = {
  GIT_EDITOR: "true", // merge/rebase --continue accept the default message instead of opening vim
  GIT_SEQUENCE_EDITOR: "true",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GH_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0", // fail fast instead of hanging on a hidden username prompt
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  CLICOLOR_FORCE: "1",
};

/**
 * Run one command (argv array, no shell — args can never be interpreted as
 * shell syntax). Never throws: callers check `ok`.
 */
export async function run(argv, { cwd, input, timeoutMs = 120_000, color = true, signal } = {}) {
  let [bin, ...args] = argv;
  // Test hook: GITCAT_GH_SHIM=path/to/fake-gh.mjs replaces the real gh, so GitHub
  // flows can be tested end to end without touching a real account.
  if (bin === "gh" && process.env.GITCAT_GH_SHIM) [bin, args] = [process.execPath, [process.env.GITCAT_GH_SHIM, ...args]];
  const finalArgs = bin === "git" && color ? ["-c", "color.ui=always", ...args] : args;
  const started = Date.now();
  let r;
  try {
    r = await execa(bin, finalArgs, {
      cwd,
      input,
      reject: false,
      timeout: timeoutMs,
      cancelSignal: signal,
      // color:false must mean machine-readable: gh colorizes --json output under CLICOLOR_FORCE
      env: color ? { ...process.env, ...CHILD_ENV } : { ...process.env, ...CHILD_ENV, CLICOLOR_FORCE: "0", NO_COLOR: "1" },
      stripFinalNewline: true,
      windowsHide: true,
    });
  } catch (err) {
    r = { exitCode: 1, stdout: "", stderr: String(err.message || err) };
  }
  const exitCode = r.exitCode ?? (r.timedOut ? 124 : 1);
  if (r.isCanceled) return { ok: false, exitCode: 130, stdout: "", stderr: "cancelled", ms: Date.now() - started };
  return {
    ok: exitCode === 0,
    exitCode,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString() || (r.timedOut ? `timed out after ${timeoutMs / 1000}s` : ""),
    ms: Date.now() - started,
  };
}

/** Quiet helper for context gathering: no colors, trimmed stdout, "" on failure. */
export async function q(argv, cwd) {
  const r = await run(argv, { cwd, color: false, timeoutMs: 15_000 });
  return r.ok ? r.stdout.trim() : "";
}

/** Hand the real terminal to a child (gh auth login etc). */
export async function runInteractive(argv, { cwd } = {}) {
  const [bin, ...args] = argv;
  const r = await execa(bin, args, { cwd, stdio: "inherit", reject: false });
  return { ok: r.exitCode === 0, exitCode: r.exitCode ?? 1, stdout: "", stderr: "", ms: 0 };
}

/** Render argv for display, quoting args that need it. */
export function fmt(argv) {
  return argv
    .map((a) => {
      const s = String(a);
      if (s === "") return '""';
      return /[\s"'`$&|<>;()*?#!]/.test(s) ? `"${s.replace(/(["\\$`])/g, "\\$1")}"` : s;
    })
    .join(" ");
}

/**
 * Split a typed command line into argv, honoring single/double quotes.
 * Used for raw `git ...` input and for gh/git args the model returns as a string.
 */
export function splitArgs(line) {
  const out = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && (line[i + 1] === '"' || line[i + 1] === "\\")) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}
