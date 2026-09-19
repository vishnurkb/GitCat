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
    fix: (s, argv) =>
      /^(switch|checkout|pull|merge|rebase|cherry-pick|revert|stash)$/.test(argv[1] || "")
        ? {
            // park the edits, do what was asked, bring the edits back
            cause: "Your uncommitted changes would be overwritten. Stashing them, retrying, then restoring them.",
            steps: [{ op: "stash", args: { untracked: true, message: "gitcat: auto-stash" } }],
            after: [{ op: "stash_pop", args: {} }],
          }
        : { cause: "You have uncommitted changes that this would overwrite.", steps: null },
  },
  {
    test: /Cannot delete branch '([^']+)' (checked out|used by worktree)/i,
    fix: (s, argv, output) => {
      const b = output.match(/Cannot delete branch '([^']+)'/i)[1];
      // checked out in a DIFFERENT worktree: switching here won't help
      const wt = (output.match(/used by worktree at '([^']+)'/i) || [])[1];
      if (wt && s.root && wt.replace(/\\/g, "/").toLowerCase() !== s.root.replace(/\\/g, "/").toLowerCase())
        return { cause: `"${b}" is checked out in another worktree (${wt}). Remove that worktree first ("remove the worktree ${wt}"), then delete the branch.`, steps: [] };
      if (b === s.defaultBranch) return { cause: `"${b}" is your main branch and you're on it — refusing to delete it.`, steps: [] };
      return { cause: `You're currently on "${b}", so git can't delete it. Switching to ${s.defaultBranch} first.`, steps: [{ op: "switch", args: { branch: s.defaultBranch } }] };
    },
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
    test: /There is no merge to abort|MERGE_HEAD missing|No rebase in progress|no cherry-pick or revert in progress/i,
    fix: () => ({ cause: `Nothing is in progress to cancel — the last merge/rebase already finished. To undo a finished merge, say "undo the last merge".`, steps: [] }),
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
    fix: (s, argv, output) => {
      // Only switch accounts when the repo's OWNER is one of the user's other
      // logged-in accounts. Guessing ("maybe it's the other account") flips the
      // user's gh login back and forth for a repo that simply doesn't exist.
      const url = s.remoteUrls?.[s.upstreamRemote || s.defaultRemote] || "";
      const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      const owner = m?.[1] || "";
      const other = (s.ghAccounts || []).find((a) => a !== s.ghUser && a.toLowerCase() === owner.toLowerCase());
      if (other)
        return {
          cause: `The repo belongs to "${other}" but the active GitHub account is "${s.ghUser}".`,
          steps: [{ op: "gh_switch_account", args: { user: other } }, { op: "gh_setup_git" }],
        };
      if (/Repository not found|not found/i.test(output))
        return { cause: `GitHub says ${m ? `${owner}/${m[2]}` : "this repository"} doesn't exist, or "${s.ghUser}" can't access it. Check the URL (${url || "no remote"}) — or create the repo first.`, steps: [] };
      return { cause: `GitHub rejected the credentials for "${s.ghUser}". Re-linking git to gh's login.`, steps: [{ op: "gh_setup_git" }] };
    },
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
    if (r.test.test(output)) return r.fix(snap, argv, output);
  }
  return null;
}
