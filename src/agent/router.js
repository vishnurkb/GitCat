// Zero-token fast path. If the input is an exact common phrase or a literal
// git/gh command, we skip the model entirely (0 tokens, ~0 ms of "thinking").
// Anything fuzzier goes to the planner.

const PHRASES = {
  status: [{ op: "status" }],
  st: [{ op: "status" }],
  s: [{ op: "status" }],
  "whats changed": [{ op: "status" }],
  "what changed": [{ op: "status" }],
  diff: [{ op: "diff" }],
  "show diff": [{ op: "diff" }],
  "staged diff": [{ op: "diff", args: { staged: true } }],
  log: [{ op: "log" }],
  history: [{ op: "log" }],
  "show history": [{ op: "log" }],
  graph: [{ op: "log", args: { graph: true } }],
  "log graph": [{ op: "log", args: { graph: true } }],
  branches: [{ op: "branch_list" }],
  "list branches": [{ op: "branch_list" }],
  "all branches": [{ op: "branch_list", args: { remote: true } }],
  remotes: [{ op: "remote_list" }],
  tags: [{ op: "tag_list" }],
  stashes: [{ op: "stash_list" }],
  "stash list": [{ op: "stash_list" }],
  stash: [{ op: "stash", args: { untracked: true } }],
  "stash pop": [{ op: "stash_pop" }],
  unstash: [{ op: "stash_pop" }],
  push: [{ op: "push" }],
  pull: [{ op: "pull" }],
  "pull rebase": [{ op: "pull", args: { rebase: true } }],
  fetch: [{ op: "fetch", args: { prune: true } }],
  sync: [{ op: "sync" }],
  "undo last commit": [{ op: "undo_commit", args: { n: 1 } }],
  "undo commit": [{ op: "undo_commit", args: { n: 1 } }],
  "unstage all": [{ op: "unstage" }],
  "add all": [{ op: "add", args: { all: true } }],
  "stage all": [{ op: "add", args: { all: true } }],
  commit: [{ op: "commit" }],
  "commit all": [{ op: "add", args: { all: true } }, { op: "commit" }],
  "commit and push": [{ op: "add", args: { all: true } }, { op: "commit" }, { op: "push" }],
  ship: [{ op: "add", args: { all: true } }, { op: "commit" }, { op: "push" }],
  init: [{ op: "init" }],
  "git init": [{ op: "init" }],
  whoami: [{ op: "whoami" }, { op: "gh_status" }],
  "github status": [{ op: "gh_status" }],
  "gh status": [{ op: "gh_status" }],
  "switch account": [{ op: "gh_switch_account" }],
  prs: [{ op: "gh_pr_list" }],
  "pr list": [{ op: "gh_pr_list" }],
  "list prs": [{ op: "gh_pr_list" }],
  issues: [{ op: "gh_issue_list" }],
  "my repos": [{ op: "gh_repo_list" }],
  repos: [{ op: "gh_repo_list" }],
  reflog: [{ op: "reflog" }],
  contributors: [{ op: "contributors" }],
  conflicts: [{ op: "conflicts" }],
  abort: [{ op: "abort" }],
  continue: [{ op: "continue" }],
  worktrees: [{ op: "worktree_list" }],
  browse: [{ op: "gh_browse" }],
};

export const normalize = (s) =>
  s
    .toLowerCase()
    .replace(/[?!.,'"`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(please|pls|plz|git ?cat|hey) /, "")
    .trim();

/**
 * @returns {null | {kind:"steps", steps} | {kind:"raw", command}}
 */
export function fastRoute(input, snap = {}) {
  const text = input.trim();
  // literal command: "git log -3" / "gh pr list" / "!git ..."
  const lit = text.replace(/^!\s*/, "");
  if (/^(git|gh)\s+\S/.test(lit)) return { kind: "raw", command: lit };
  const cd = lit.match(/^cd\s+(.+)$/i);
  if (cd) return { kind: "steps", steps: [{ op: "cd", args: { path: cd[1].trim().replace(/^["']|["']$/g, "") } }] };

  const key = normalize(text);
  if (PHRASES[key]) return { kind: "steps", steps: PHRASES[key].map((s) => ({ op: s.op, args: { ...(s.args || {}) } })) };

  // "switch to X" / "checkout X" where X is exactly an existing branch — unambiguous
  let m = text.trim().match(/^(?:switch to|switch|checkout|check out)\s+([\w./-]+)$/i);
  const known = [...(snap.branches || []), ...(snap.remoteBranches || []).map((b) => b.replace(/^[^/]+\//, ""))];
  if (m && known.includes(m[1])) return { kind: "steps", steps: [{ op: "switch", args: { branch: m[1] } }] };
  m = text.trim().match(/^commit\s+(?:-m\s+)?["'](.+)["']$/i);
  if (m) return { kind: "steps", steps: [{ op: "commit", args: { message: m[1] } }] };
  return null;
}
