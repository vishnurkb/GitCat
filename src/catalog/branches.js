// Branches, merging, rebasing, conflicts.

// A merge is concluded with a commit; rebase/cherry-pick/revert have --continue.
const finishCmd = (what) => (what === "merge" ? ["git", "commit", "--no-edit"] : ["git", what, "--continue"]);

export default [
  {
    id: "branch_create",
    desc: "create a branch (from=start point) and switch to it unless stay=true",
    params: { name: "str!", from: "str", stay: "bool" },
    risk: "write",
    build: (p) => [p.stay ? ["git", "branch", p.name, ...(p.from ? [p.from] : [])] : ["git", "switch", "-c", p.name, ...(p.from ? [p.from] : [])]],
  },
  {
    id: "switch",
    desc: "switch to an existing branch (also checks out a remote-only branch)",
    params: { branch: "str!" },
    risk: "write",
    build: (p) => [["git", "switch", p.branch]],
  },
  { id: "checkout_commit", desc: "ONLY to inspect an old commit by hash (detached HEAD, no branch). Never use it to go to a branch — that is switch", params: { ref: "str!" }, risk: "write", build: (p) => [["git", "switch", "--detach", p.ref]] },
  {
    id: "branch_rename",
    desc: "rename a branch (from omitted = current branch)",
    params: { to: "str!", from: "str" },
    risk: "write",
    build: (p) => [["git", "branch", "-m", ...(p.from ? [p.from] : []), p.to]],
  },
  {
    id: "branch_delete",
    desc: "delete a local branch. force=true deletes even if unmerged",
    params: { name: "str!", force: "bool" },
    risk: (p) => (p.force ? "danger" : "write"),
    warn: (p) => (p.force ? "Unmerged commits on this branch become unreachable." : ""),
    build: (p) => [["git", "branch", p.force ? "-D" : "-d", p.name]],
  },
  {
    id: "merge",
    desc: "merge a branch into the current branch",
    params: { branch: "str!", no_ff: "bool", squash: "bool", message: "str", allow_unrelated: "bool" },
    risk: "write",
    build: (p) => {
      const a = ["git", "merge"];
      if (p.no_ff) a.push("--no-ff");
      if (p.squash) a.push("--squash");
      if (p.allow_unrelated) a.push("--allow-unrelated-histories");
      if (p.message) a.push("-m", p.message);
      else if (!p.squash) a.push("--no-edit");
      a.push(p.branch);
      return [a];
    },
  },
  {
    id: "rebase",
    desc: "replay current branch commits on top of `onto`",
    params: { onto: "str!" },
    risk: "danger",
    warn: () => "Rebase rewrites this branch's commits. If they are already pushed you will need a force push.",
    build: (p) => [["git", "rebase", p.onto]],
  },
  {
    id: "squash_last",
    desc: "combine the last n commits into one commit",
    params: { n: "int!", message: "str" },
    risk: "danger",
    autoMessage: true,
    warn: () => "Rewrites history of the last commits (force push needed if already pushed).",
    build: (p) => [["git", "reset", "--soft", `HEAD~${p.n}`], ["git", "commit", "-m", p.message || `squash last ${p.n} commits`]],
  },
  { id: "cherry_pick", desc: "copy commits onto the CURRENT branch (if the user names another target branch, switch to it first)", params: { refs: "list!" }, risk: "write", build: (p) => [["git", "cherry-pick", ...p.refs]] },
  {
    id: "abort",
    desc: "abort an in-progress merge/rebase/cherry-pick/revert (what omitted = detect)",
    params: { what: "merge|rebase|cherry-pick|revert" },
    risk: "write",
    build: (p, ctx) => [["git", p.what || ctx.snap.inProgress || "merge", "--abort"]],
  },
  {
    id: "continue",
    desc: "continue an in-progress merge/rebase/cherry-pick after resolving conflicts",
    params: { what: "merge|rebase|cherry-pick|revert" },
    risk: "write",
    build: (p, ctx) => {
      const what = p.what || ctx.snap.inProgress;
      // already finished (e.g. resolve_conflicts concluded it): show state instead of failing
      if (!what) return [["git", "status", "-sb"]];
      return [finishCmd(what)];
    },
  },
  {
    id: "resolve_conflicts",
    desc: "resolve conflicted files by taking one side (ours=current branch, theirs=incoming), stage them, and finish the merge once none remain",
    params: { side: "ours|theirs!", paths: "list" },
    risk: "danger",
    warn: (p) => `The other side's version of conflicted lines is dropped (keeping ${p.side}).`,
    build: (p, ctx) => {
      const conflicts = ctx.snap.conflicts || [];
      const files = p.paths || conflicts;
      if (!files?.length) return [["git", "status", "-sb"]];
      const cmds = [["git", "checkout", `--${p.side}`, "--", ...files], ["git", "add", "--", ...files]];
      // resolving every conflict means the user wants the merge done — conclude it
      if (ctx.snap.inProgress && conflicts.every((f) => files.includes(f))) cmds.push(finishCmd(ctx.snap.inProgress));
      return cmds;
    },
  },
  { id: "conflicts", desc: "list files with merge conflicts", risk: "read", build: () => [["git", "diff", "--name-only", "--diff-filter=U"]] },
];
