import inspect from "./inspect.js";
import changes from "./changes.js";
import branches from "./branches.js";
import remotes from "./remotes.js";
import github from "./github.js";
import repo from "./repo.js";
import { normalizeArgs, signature } from "./params.js";

const tag = (area, ops) => ops.map((o) => ({ ...o, area }));
export const OPS = [
  ...tag("inspect", inspect),
  ...tag("changes", changes),
  ...tag("branches", branches),
  ...tag("remotes", remotes),
  ...tag("github", github),
  ...tag("repo", repo),
];
export const OP_BY_ID = new Map(OPS.map((o) => [o.id, o]));

export const riskOf = (op, args) => (typeof op.risk === "function" ? op.risk(args) : op.risk) || "write";
export const warnOf = (op, args) => (typeof op.warn === "function" ? op.warn(args) : "") || "";

/**
 * Turn a model step {op, args} into a checked step. Unknown op or missing
 * required args → {error}. Commands are built later (buildCommands) because
 * some depend on the repo state *after* earlier steps ran.
 */
export function resolveStep(raw) {
  const op = OP_BY_ID.get(String(raw?.op || "").trim());
  if (!op) return { error: `unknown operation "${raw?.op}"` };
  const { args, missing } = normalizeArgs(op, raw.args || {});
  // auto-message ops may omit the message: we write it from the diff
  const stillMissing = missing.filter((m) => !(op.autoMessage && m === "message"));
  if (stillMissing.length) return { error: `${op.id} needs: ${stillMissing.join(", ")}`, op, args };
  return { op, args, risk: riskOf(op, args), warn: warnOf(op, args) };
}

export function buildCommands(step, ctx) {
  return step.op.build(step.args, ctx).filter(Boolean);
}

/** Compact one-line-per-op listing used in the system prompt. */
export function catalogText(ops = OPS) {
  return ops
    .map((o) => {
      const sig = signature(o);
      return `${o.id}(${sig}) — ${o.desc}`;
    })
    .join("\n");
}

// ---- slim catalog for rate-limited hosted models ---------------------------
// Groq's free tier allows ~8k tokens/minute, so the hosted prompt only lists
// the catalog areas a request plausibly needs (+ a core set). The local model
// always gets the full catalog: its KV cache makes the static prompt free.

const CORE = new Set(["status", "diff", "log", "show", "add", "commit", "push", "pull", "switch", "branch_create", "undo_commit", "stash", "stash_pop", "git_raw", "gh_raw"]);
const AREA_WORDS = {
  inspect: /\b(who|blame|history|reflog|lost|grep|search|find|contributor\w*|config|files?|compare|differen\w*|changed?|show|what|when|how many|ahead|behind|log|graph)\b/i,
  changes: /\b(add|stage|unstage|commit|save|undo|reset|revert|discard|throw|restore|clean|untrack|track\w*|ignore|remove|delete|rm|move|stash|squash|amend|keep|back|chang\w*|chnag\w*)\b/i,
  branches: /\b(branch\w*|switch|checkout|merge|rebase|cherry|pick|conflict\w*|abort|cancel|continue|squash|ours|theirs|mine|keep|rename|detach\w*)\b/i,
  remotes: /\b(push|pull|fetch|sync|upstream|remote|origin|tags?|url|send|upload|download|latest|up to date|force|psuh|release)\b/i,
  github: /\b(github|gh|repo|repository|pr|prs|pull request|issues?|release|account|login|log in|logged|fork|clone|actions|ci|checks|browse|public|private|online|secrets?)\b/i,
  repo: /\b(init|initiali[sz]e|clone|config|email|name|identity|ignore|gitignore|worktree|submodule|cd|folder|directory|bisect|secrets?|raw)\b/i,
};

export function selectOps(request) {
  const areas = Object.entries(AREA_WORDS)
    .filter(([, re]) => re.test(request))
    .map(([a]) => a);
  if (!areas.length) return OPS; // can't tell — send everything
  return OPS.filter((o) => CORE.has(o.id) || areas.includes(o.area));
}
