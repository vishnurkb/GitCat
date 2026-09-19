// Read-only operations. Risk "read": always run without asking.

const splitRef = (ref) => String(ref).trim().split(/\s+/).filter(Boolean); // "HEAD~1 HEAD" -> two args

export default [
  { id: "status", desc: "show working tree status (branch, ahead/behind, changed files)", risk: "read", build: () => [["git", "status", "-sb"]] },
  { id: "current_branch", desc: "print only the current branch name", risk: "read", build: () => [["git", "branch", "--show-current"]] },
  {
    id: "diff",
    desc: "show changes. staged=only staged; ref=compare with a commit/branch (e.g. main, HEAD~1, a..b); to=second commit/branch; stat=summary only",
    params: { staged: "bool", paths: "list", ref: "str", to: "str", stat: "bool" },
    risk: "read",
    build: (p) => [["git", "diff", ...(p.staged ? ["--staged"] : []), ...(p.stat ? ["--stat"] : []), ...(p.ref ? splitRef(p.ref) : []), ...(p.to ? [p.to] : []), ...(p.paths ? ["--", ...p.paths] : [])]],
  },
  {
    id: "log",
    desc: "show commit history. graph=branch graph over all branches; grep=search messages; pickaxe=commits that added/removed this exact text (-S); regex=commits whose diff matches a regex (-G); since/until=dates; all=every branch",
    params: { n: "int", author: "str", since: "str", until: "str", grep: "str", pickaxe: "str", regex: "str", paths: "list", ref: "str", graph: "bool", all: "bool", full: "bool" },
    risk: "read",
    build: (p) => {
      const a = ["git", "log", `-n${p.n || (p.graph ? 30 : 15)}`];
      if (p.graph) a.push("--graph", "--all", "--decorate", "--oneline");
      else if (!p.full) a.push("--format=%C(yellow)%h%Creset %C(green)%ad%Creset %s %C(cyan)<%an>%Creset%C(auto)%d", "--date=short");
      if (p.all && !p.graph) a.push("--all");
      if (p.author) a.push(`--author=${p.author}`);
      if (p.since) a.push(`--since=${p.since}`);
      if (p.until) a.push(`--until=${p.until}`);
      if (p.grep) a.push(`--grep=${p.grep}`, "-i");
      if (p.pickaxe) a.push(`-S${p.pickaxe}`);
      if (p.regex) a.push(`-G${p.regex}`);
      if (p.ref) a.push(...splitRef(p.ref));
      if (p.paths) a.push("--", ...p.paths);
      return [a];
    },
  },
  { id: "show", desc: "show one commit's details and diff (default HEAD)", params: { ref: "str", stat: "bool" }, risk: "read", build: (p) => [["git", "show", ...(p.stat ? ["--stat"] : []), p.ref || "HEAD"]] },
  { id: "blame", desc: "who last changed each line of a file", params: { path: "str!" }, risk: "read", build: (p) => [["git", "blame", "--date=short", p.path]] },
  {
    id: "branch_list",
    desc: "list branches. remote=true lists local + remote (GitHub) branches; remote_only=true lists only remote branches",
    params: { remote: "bool", remote_only: "bool" },
    risk: "read",
    build: (p) => [["git", "branch", "-vv", ...(p.remote_only ? ["-r"] : p.remote ? ["-a"] : [])]],
  },
  { id: "remote_list", desc: "list remotes and their URLs", risk: "read", build: () => [["git", "remote", "-v"]] },
  { id: "remote_show", desc: "details of a remote: its branches, tracking and push/pull config", params: { name: "str" }, risk: "read", build: (p) => [["git", "remote", "show", p.name || "origin"]] },
  { id: "tag_list", desc: "list tags", risk: "read", build: () => [["git", "tag", "-n", "--sort=-creatordate"]] },
  { id: "stash_list", desc: "list stashes", risk: "read", build: () => [["git", "stash", "list"]] },
  { id: "stash_show", desc: "show what a stash contains", params: { index: "int" }, risk: "read", build: (p) => [["git", "stash", "show", "-p", `stash@{${p.index ?? 0}}`]] },
  { id: "reflog", desc: "history of where HEAD has been (find lost commits to recover)", params: { n: "int" }, risk: "read", build: (p) => [["git", "reflog", `-n${p.n || 20}`]] },
  { id: "contributors", desc: "commit count per author", risk: "read", build: () => [["git", "shortlog", "-sne", "HEAD"]] },
  { id: "whoami", desc: "show configured git user name/email", risk: "read", build: () => [["git", "config", "user.name"], ["git", "config", "user.email"]] },
  { id: "config_list", desc: "show all git config (global=true only global settings)", params: { global: "bool" }, risk: "read", build: (p) => [["git", "config", "--list", p.global ? "--global" : "--show-origin"]] },
  { id: "config_get", desc: "read one git config value (e.g. user.email, init.defaultBranch)", params: { key: "str!", global: "bool" }, risk: "read", build: (p) => [["git", "config", ...(p.global ? ["--global"] : []), "--get", p.key]] },
  { id: "ls_files", desc: "list tracked files (pattern optional)", params: { pattern: "str" }, risk: "read", build: (p) => [["git", "ls-files", ...(p.pattern ? [p.pattern] : [])]] },
  { id: "search_code", desc: "grep the current tracked files for text", params: { text: "str!" }, risk: "read", build: (p) => [["git", "grep", "-n", "-I", p.text]] },
  { id: "compare_branches", desc: "commits in `to` that are not in `from` (what would merge)", params: { from: "str!", to: "str!" }, risk: "read", build: (p) => [["git", "log", "--oneline", `${p.from}..${p.to}`]] },
  {
    id: "repo_health",
    desc: "repository maintenance: fsck=check integrity, count=object count/size, gc=clean up and optimize",
    params: { action: "fsck|count|gc!" },
    risk: (p) => (p.action === "gc" ? "write" : "read"),
    build: (p) => [p.action === "fsck" ? ["git", "fsck"] : p.action === "count" ? ["git", "count-objects", "-v", "-H"] : ["git", "gc"]],
  },
];
