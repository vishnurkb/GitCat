import { q } from "../exec/run.js";
import { chat } from "../llm/index.js";
import { COMMIT_SYSTEM } from "./prompt.js";

const BUDGET = 7000; // total diff characters sent to the model
const MAX_FILES = 40;

/**
 * Collect what this commit will contain: the full file list (always complete)
 * plus a diff where every file gets a share of the budget. A plain truncated
 * diff only ever showed the first few files, so a commit that added a feature
 * AND touched docs got labelled "docs:". Returns "" if there's nothing to commit.
 */
export async function diffFor(op, args, cwd) {
  if (op.id === "squash_last") {
    const n = args.n || 2;
    const [stat, subjects] = await Promise.all([q(["git", "diff", "--stat=120", `HEAD~${n}`, "HEAD"], cwd), q(["git", "log", "--format=- %s", `-n${n}`], cwd)]);
    if (!stat) return "";
    return `Commits being squashed:\n${subjects}\n\n${stat}\n\n${await perFileDiff([`HEAD~${n}`, "HEAD"], cwd)}`;
  }
  const hasHead = !!(await q(["git", "rev-parse", "--verify", "--quiet", "HEAD"], cwd));
  const range = args.all && hasHead ? ["HEAD"] : ["--cached"];
  const stat = await q(["git", "diff", "--stat=120", ...range], cwd);
  if (!stat) return "";
  return `${stat}\n\n${await perFileDiff(range, cwd)}`;
}

async function perFileDiff(range, cwd) {
  const files = (await q(["git", "diff", "--name-only", ...range], cwd)).split(/\r?\n/).filter(Boolean);
  const shown = files.slice(0, MAX_FILES);
  const each = Math.max(250, Math.floor(BUDGET / Math.max(1, shown.length)));
  const parts = await Promise.all(
    shown.map(async (f) => {
      const d = await q(["git", "diff", "-U1", ...range, "--", f], cwd);
      return d.length > each ? `${d.slice(0, each)}\n…(${f}: ${d.length - each} more chars)` : d;
    }),
  );
  const more = files.length > shown.length ? `\n…and ${files.length - shown.length} more files (see stat above)` : "";
  return parts.join("\n") + more;
}

/** Deterministic fallback — a commit must never run without a message. */
export function fallbackMessage(diff, hasCommits) {
  if (!hasCommits) return "Initial commit";
  const files = String(diff)
    .split("\n")
    .filter((l) => /\|\s+\d+/.test(l))
    .map((l) => l.split("|")[0].trim());
  return files.length === 1 ? `chore: update ${files[0]}` : `chore: update ${files.length || "several"} files`;
}

/** Ask the model for a conventional commit message. Falls back to a stat-based message. */
export async function writeCommitMessage(settings, diff, cwd, signal, llm = chat) {
  const recent = await q(["git", "log", "-5", "--format=%s"], cwd);
  const user = `${recent ? `Recent commit subjects in this repo (style reference only — never reuse them; describe THIS diff):\n${recent}\n\n` : ""}Changes (the file list is complete; per-file diffs may be cut):\n${diff}`;
  try {
    const r = await llm(settings, [
      { role: "system", content: COMMIT_SYSTEM },
      { role: "user", content: user },
    ], { maxTokens: 600, signal });
    const msg = r.text
      .replace(/^```\w*\n?|```$/g, "")
      .replace(/^["'`]|["'`]$/g, "")
      .replace(/^(\w+)\(\s*[:\s]*\)(!?):/, "$1$2:") // "feat(:): x" / "feat(): x" -> "feat: x"
      .trim();
    if (msg) return { message: msg, usage: r };
  } catch {
    /* fall through to the heuristic */
  }
  return { message: fallbackMessage(diff, !!recent) };
}
