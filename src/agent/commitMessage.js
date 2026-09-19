import { q } from "../exec/run.js";
import { chat } from "../llm/index.js";
import { COMMIT_SYSTEM } from "./prompt.js";

const MAX_DIFF = 7000;

/** Collect the diff this commit will contain. Returns "" if there is nothing to commit. */
export async function diffFor(op, args, cwd) {
  if (op.id === "squash_last") {
    const n = args.n || 2;
    const [stat, diff, subjects] = await Promise.all([
      q(["git", "diff", "--stat", `HEAD~${n}`, "HEAD"], cwd),
      q(["git", "diff", "-U2", `HEAD~${n}`, "HEAD"], cwd),
      q(["git", "log", "--format=- %s", `-n${n}`], cwd),
    ]);
    return stat ? `Commits being squashed:\n${subjects}\n\n${stat}\n\n${diff}` : "";
  }
  const range = args.all ? ["HEAD"] : ["--cached"];
  const [stat, diff] = await Promise.all([q(["git", "diff", "--stat", ...range], cwd), q(["git", "diff", "-U2", ...range], cwd)]);
  return stat ? `${stat}\n\n${diff}` : "";
}

/** Ask the model for a conventional commit message. Falls back to a stat-based message. */
export async function writeCommitMessage(settings, diff, cwd, signal, llm = chat) {
  const recent = await q(["git", "log", "-5", "--format=%s"], cwd);
  const body = diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + `\n…(diff truncated, ${diff.length - MAX_DIFF} more chars)` : diff;
  const user = `${recent ? `Recent commit subjects in this repo (style reference only — never reuse them; describe THIS diff):\n${recent}\n\n` : ""}Diff:\n${body}`;
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
  const files = diff
    .split("\n")
    .filter((l) => /\|\s+\d+/.test(l))
    .map((l) => l.split("|")[0].trim());
  return { message: files.length === 1 ? `chore: update ${files[0]}` : `chore: update ${files.length} files` };
}
