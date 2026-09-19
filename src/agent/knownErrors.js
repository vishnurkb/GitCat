// Deterministic diagnosis for the git/gh failures people hit most. Each entry
// returns {cause, steps} — steps are catalog ops (same shape the model returns).
// Checked before asking the model: instant, free, and always right for these.

const RULES = [
  {
    test: /not a git repository/i,
    fix: () => ({ cause: "This folder isn't a git repository yet.", steps: [{ op: "init" }] }),
  },
  {
    test: /has no upstream branch|no upstream configured/i,
    fix: (s) => ({ cause: `Branch "${s.branch}" has never been pushed, so git doesn't know where to send it.`, steps: [{ op: "push", args: {} }] }),
  },
  {
    test: /does not appear to be a git repository|No such remote|'origin' does not appear/i,
    fix: (s) =>
      s.remotes?.length
        ? { cause: `That remote doesn't exist. Remotes here: ${s.remotes.join(", ")}.`, steps: [] }
        : { cause: "This repo has no remote yet. Create a GitHub repo for it (or give me a URL to connect).", steps: [{ op: "gh_repo_create", args: { visibility: "private" } }] },
  },
  {
    test: /src refspec .* does not match any|does not have any commits yet|ambiguous argument 'HEAD'|bad default revision 'HEAD'/i,
    fix: (s) => ({
      cause: "There are no commits on this branch yet — nothing to push or show.",
      steps: s.staged?.length || s.unstaged?.length || s.untracked?.length ? [{ op: "add", args: { all: true } }, { op: "commit", args: { message: "Initial commit" } }] : [],
    }),
  },
  {
    test: /\[rejected\].*\((fetch first|non-fast-forward)\)|Updates were rejected because the (tip of your current branch is behind|remote contains work)/is,
    fix: () => ({ cause: "The remote has commits you don't have locally, so git refuses to overwrite them.", steps: [{ op: "pull", args: { rebase: true } }, { op: "push", args: {} }] }),
  },
  {
    test: /refusing to merge unrelated histories/i,
    fix: (s, argv) => ({
      cause: "Local and remote histories were started separately (e.g. GitHub repo created with a README).",
      steps: argv.includes("merge") ? [] : [{ op: "pull", args: { allow_unrelated: true } }],
    }),
  },
  {
    test: /divergent branches|Need to specify how to reconcile/i,
    fix: () => ({ cause: "Your branch and the remote both have new commits; git needs to know whether to merge or rebase.", steps: [{ op: "pull", args: { rebase: true } }] }),
  },
  {
    test: /Please tell me who you are|Author identity unknown|empty ident name/i,
    fix: (s) => ({
      cause: "git doesn't know your name/email for commits.",
      steps: s.ghUser ? [{ op: "set_identity", args: { name: s.ghUser, email: `${s.ghUser}@users.noreply.github.com`, global: true } }] : [],
    }),
  },
  {
    test: /remote (\S+) already exists/i,
    fix: () => ({ cause: "A remote with that name already exists — its URL can be changed instead.", steps: null }),
  },
  {
    test: /Your local changes to the following files would be overwritten|Please commit your changes or stash them/i,
    fix: () => ({ cause: "You have uncommitted changes that this would overwrite.", steps: null }),
  },
  {
    test: /nothing added to commit but untracked files present|no changes added to commit/i,
    fix: () => ({ cause: "Nothing was staged for the commit.", steps: [{ op: "add", args: { all: true } }, { op: "commit", args: {} }] }),
  },
  {
    test: /nothing to commit, working tree clean/i,
    fix: () => ({ cause: "Nothing to commit — the working tree is clean.", steps: [] }),
  },
  {
    test: /CONFLICT|Automatic merge failed|could not apply|Resolve all conflicts/i,
    fix: (s) => ({
      cause: `Merge conflict${s.conflicts?.length ? ` in ${s.conflicts.join(", ")}` : ""}. Fix the conflicted files (look for <<<<<<< markers), then say "continue" — or say "abort" to back out, or "keep mine"/"keep theirs".`,
      steps: [],
    }),
  },
  {
    test: /You have not concluded your merge|MERGE_HEAD exists|rebase-merge directory|in the middle of (a|an) (rebase|am)/i,
    fix: (s) => ({ cause: `A ${s.inProgress || "merge/rebase"} is still in progress. Finish it ("continue") or cancel it ("abort") first.`, steps: [] }),
  },
  {
    test: /not fully merged/i,
    fix: (s, argv) => ({ cause: `That branch has commits that aren't merged anywhere. Deleting it would lose them. Say "force delete ${argv.at(-1)}" if you're sure.`, steps: [] }),
  },
  {
    test: /Permission to .* denied|403|Authentication failed|could not read Username|terminal prompts disabled|Repository not found/i,
    fix: (s) => ({
      cause:
        s.ghAccounts?.length > 1
          ? `GitHub rejected the credentials. Active account is "${s.ghUser}" — the repo may belong to another account (${s.ghAccounts.filter((a) => a !== s.ghUser).join(", ")}).`
          : "GitHub rejected the credentials (or the repo doesn't exist / you have no access).",
      steps: s.ghAccounts?.length > 1 ? [{ op: "gh_switch_account", args: {} }, { op: "gh_setup_git" }] : [{ op: "gh_setup_git" }],
    }),
  },
  {
    test: /HEAD detached|You are not currently on a branch/i,
    fix: () => ({ cause: "You're on a detached HEAD (not on any branch). Create a branch here to keep this work.", steps: null }),
  },
  {
    test: /already exists/i,
    fix: () => ({ cause: "Something with that name already exists.", steps: null }),
  },
  {
    test: /delete_repo|admin rights|HTTP 403: Must have admin rights/i,
    fix: () => ({ cause: 'Your gh token lacks the "delete_repo" scope. Run `gh auth refresh -h github.com -s delete_repo` yourself, then retry.', steps: [] }),
  },
  {
    test: /Could not resolve host|unable to access|Connection timed out|Failed to connect/i,
    fix: () => ({ cause: "Network problem reaching the remote. Check your internet connection and retry.", steps: [] }),
  },
];

/**
 * @returns {null | {cause, steps: Array|null}}  steps=null means "cause known, let the model plan the fix"
 */
export function matchKnownError(output, snap, argv = []) {
  for (const r of RULES) {
    if (r.test.test(output)) return r.fix(snap, argv);
  }
  return null;
}
