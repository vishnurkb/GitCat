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
    desc: "undo the last n commits but KEEP the changes (soft reset)",
    params: { n: "int" },
    risk: "write",
    build: (p) => [["git", "reset", "--soft", `HEAD~${p.n || 1}`]],
  },
  {
    id: "reset",
    desc: "move branch to ref. mode soft/mixed keep changes; hard DISCARDS changes",
    params: { ref: "str", mode: "soft|mixed|hard" },
    risk: (p) => (p.mode === "hard" ? "danger" : "write"),
    warn: (p) => (p.mode === "hard" ? "--hard permanently discards uncommitted changes and moves the branch." : ""),
    build: (p) => [["git", "reset", `--${p.mode || "mixed"}`, p.ref || "HEAD"]],
  },
  { id: "revert", desc: "create a new commit that undoes a commit (safe for pushed history)", params: { ref: "str!" }, risk: "write", build: (p) => [["git", "revert", "--no-edit", p.ref]] },
  {
    id: "discard",
    desc: "throw away uncommitted edits to tracked files (no paths = all). To also delete new untracked files add clean",
    params: { paths: "list" },
    risk: "danger",
    warn: () => "Uncommitted edits in these files are lost for good.",
    build: (p) => [["git", "restore", "--", ...(p.paths || ["."])]],
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
  { id: "stash_pop", desc: "re-apply a stash and remove it", params: { index: "int" }, risk: "write", build: (p) => [["git", "stash", "pop", ...(p.index !== undefined ? [`stash@{${p.index}}`] : [])]] },
  { id: "stash_apply", desc: "re-apply a stash but keep it", params: { index: "int" }, risk: "write", build: (p) => [["git", "stash", "apply", ...(p.index !== undefined ? [`stash@{${p.index}}`] : [])]] },
  {
    id: "stash_drop",
    desc: "delete a stash (all=true clears every stash)",
    params: { index: "int", all: "bool" },
    risk: "danger",
    warn: () => "Dropped stashes are hard to recover.",
    build: (p) => [p.all ? ["git", "stash", "clear"] : ["git", "stash", "drop", `stash@{${p.index ?? 0}}`]],
  },
];
