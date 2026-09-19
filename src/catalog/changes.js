// Staging, committing, undoing, stashing.

export default [
  {
    id: "add",
    desc: "stage files (all=true stages everything incl. new files)",
    params: { paths: "list", all: "bool" },
    risk: "write",
    build: (p) => [["git", "add", ...(p.paths && !p.all ? ["--", ...p.paths] : ["-A"])]],
  },
  {
    id: "unstage",
    desc: "unstage files but keep the edits (no paths = unstage all)",
    params: { paths: "list" },
    risk: "write",
    build: (p, ctx) =>
      ctx.snap.hasCommits ? [["git", "restore", "--staged", "--", ...(p.paths || ["."])]] : [["git", "rm", "-r", "--cached", "-q", "--", ...(p.paths || ["."])]],
  },
  {
    id: "commit",
    desc: "commit staged changes. omit message to auto-write one from the diff. all=true also stages modified tracked files. amend=rewrite last commit",
    params: { message: "str", all: "bool", amend: "bool", allow_empty: "bool" },
    risk: "write",
    autoMessage: true,
    build: (p) => {
      const a = ["git", "commit"];
      if (p.all) a.push("-a");
      if (p.amend) a.push("--amend");
      if (p.allow_empty) a.push("--allow-empty");
      if (p.message) a.push("-m", p.message);
      else if (p.amend) a.push("--no-edit");
      return [a];
    },
  },
  {
    id: "undo_commit",
    desc: "undo the last n commits. default keeps the changes STAGED; unstage=true keeps them as unstaged edits; discard=true THROWS the changes away",
    params: { n: "int", unstage: "bool", discard: "bool" },
    risk: (p) => (p.discard ? "danger" : "write"),
    warn: (p) => (p.discard ? "The undone commit's changes (and any uncommitted edits) are discarded. Recoverable only via reflog." : ""),
    build: (p, ctx) => {
      const n = p.n || 1;
      const mode = p.discard ? "--hard" : p.unstage ? "--mixed" : "--soft";
      // HEAD~n doesn't exist when undoing past the first commit: drop the branch
      // ref instead (files stay staged, like --soft), then unstage if asked.
      if (ctx.snap.commitCount && n >= ctx.snap.commitCount) {
        return p.unstage || p.discard ? [["git", "update-ref", "-d", "HEAD"], ["git", "rm", "-r", "--cached", "-q", "."]] : [["git", "update-ref", "-d", "HEAD"]];
      }
      return [["git", "reset", mode, `HEAD~${n}`]];
    },
  },
  {
    id: "recover_commit",
    desc: "bring back a lost/deleted commit (e.g. after a hard reset or undo) — finds it in the reflog by words from its message, or by hash",
    params: { message: "str", sha: "str" },
    risk: "write",
    build: (p) => [{ internal: "recover", message: p.message, sha: p.sha }],
  },
  {
    id: "reset",
    desc: "move branch to ref. mode soft/mixed keep changes; hard DISCARDS changes",
    params: { ref: "str", mode: "soft|mixed|hard" },
    risk: (p) => (p.mode === "hard" ? "danger" : "write"),
    warn: (p) => (p.mode === "hard" ? "--hard permanently discards uncommitted changes and moves the branch." : ""),
    build: (p) => [["git", "reset", `--${p.mode || "mixed"}`, p.ref || "HEAD"]],
  },
  {
    id: "revert",
    desc: "create a new commit that undoes a commit (safe for pushed history). For a MERGE commit set mainline=1",
    params: { ref: "str!", mainline: "int" },
    risk: "write",
    build: (p) => [["git", "revert", "--no-edit", ...(p.mainline ? ["-m", String(p.mainline)] : []), p.ref]],
  },
  {
    id: "discard",
    desc: "throw away uncommitted edits (staged AND unstaged) so files match the last commit (no paths = all). Untracked files are kept — use clean for those",
    params: { paths: "list" },
    risk: "danger",
    warn: () => "Uncommitted edits in these files are lost for good (newly added files are removed).",
    build: (p) => [["git", "restore", "--staged", "--worktree", "--source=HEAD", "--", ...(p.paths || ["."])]],
  },
  {
    id: "restore_file",
    desc: "bring a file back to how it was at ref (default HEAD)",
    params: { path: "str!", ref: "str" },
    risk: "danger",
    warn: () => "Current contents of the file are overwritten.",
    build: (p) => [["git", "restore", `--source=${p.ref || "HEAD"}`, "--", p.path]],
  },
  {
    id: "clean",
    desc: "delete untracked files (dry=true only lists them)",
    params: { dirs: "bool", dry: "bool", ignored: "bool" },
    risk: (p) => (p.dry ? "read" : "danger"),
    warn: () => "Untracked files are deleted permanently (they are not in git, so no undo).",
    build: (p) => [["git", "clean", p.dry ? "-n" : "-f", ...(p.dirs ? ["-d"] : []), ...(p.ignored ? ["-x"] : [])]],
  },
  {
    id: "untrack",
    desc: "stop tracking ALREADY-COMMITTED files but keep them on disk (e.g. node_modules, .env). Not for new/untracked files",
    params: { paths: "list!" },
    risk: "write",
    build: (p) => [["git", "rm", "-r", "--cached", "-q", "--", ...p.paths]],
  },
  { id: "remove_file", desc: "delete files and stage the deletion", params: { paths: "list!" }, risk: "danger", warn: () => "Files are deleted from disk.", build: (p) => [["git", "rm", "-r", "--", ...p.paths]] },
  { id: "move_file", desc: "rename/move a tracked file", params: { from: "str!", to: "str!" }, risk: "write", build: (p) => [["git", "mv", p.from, p.to]] },
  {
    id: "stash",
    desc: "stash uncommitted changes (untracked=true includes new files)",
    params: { message: "str", untracked: "bool" },
    risk: "write",
    build: (p) => [["git", "stash", "push", ...(p.untracked ? ["-u"] : []), ...(p.message ? ["-m", p.message] : [])]],
  },
  { id: "stash_pop", desc: "bring stashed work back (restore / unstash) and remove it from the stash list — the normal choice", params: { index: "int" }, risk: "write", build: (p) => [["git", "stash", "pop", ...(p.index !== undefined ? [`stash@{${p.index}}`] : [])]] },
  { id: "stash_apply", desc: "re-apply a stash but KEEP it in the list (only when the user wants to keep the stash)", params: { index: "int" }, risk: "write", build: (p) => [["git", "stash", "apply", ...(p.index !== undefined ? [`stash@{${p.index}}`] : [])]] },
  {
    id: "stash_drop",
    desc: "delete a stash (all=true clears every stash)",
    params: { index: "int", all: "bool" },
    risk: "danger",
    warn: () => "Dropped stashes are hard to recover.",
    build: (p) => [p.all ? ["git", "stash", "clear"] : ["git", "stash", "drop", `stash@{${p.index ?? 0}}`]],
  },
];
