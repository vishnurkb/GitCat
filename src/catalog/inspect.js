// Read-only operations. Risk "read": always run without asking.

export default [
  { id: "status", desc: "show working tree status", risk: "read", build: () => [["git", "status", "-sb"]] },
  {
    id: "diff",
    desc: "show changes. staged=only staged; ref=compare with commit/branch (e.g. main, HEAD~1, a..b); stat=summary only",
    params: { staged: "bool", paths: "list", ref: "str", stat: "bool" },
    risk: "read",
    build: (p) => [["git", "diff", ...(p.staged ? ["--staged"] : []), ...(p.stat ? ["--stat"] : []), ...(p.ref ? [p.ref] : []), ...(p.paths ? ["--", ...p.paths] : [])]],
  },
  {
    id: "log",
    desc: "show commit history. graph=branch graph over all branches",
    params: { n: "int", author: "str", since: "str", grep: "str", paths: "list", ref: "str", graph: "bool", full: "bool" },
    risk: "read",
    build: (p) => {
      const a = ["git", "log", `-n${p.n || (p.graph ? 30 : 15)}`];
      if (p.graph) a.push("--graph", "--all", "--decorate", "--oneline");
      else if (!p.full) a.push("--format=%C(yellow)%h%Creset %C(green)%ad%Creset %s %C(cyan)<%an>%Creset%C(auto)%d", "--date=short");
      if (p.author) a.push(`--author=${p.author}`);
      if (p.since) a.push(`--since=${p.since}`);
      if (p.grep) a.push(`--grep=${p.grep}`, "-i");
      if (p.ref) a.push(p.ref);
      if (p.paths) a.push("--", ...p.paths);
      return [a];
    },
  },
  { id: "show", desc: "show one commit's details and diff (default HEAD)", params: { ref: "str", stat: "bool" }, risk: "read", build: (p) => [["git", "show", ...(p.stat ? ["--stat"] : []), p.ref || "HEAD"]] },
  { id: "blame", desc: "who changed each line of a file", params: { path: "str!" }, risk: "read", build: (p) => [["git", "blame", "--date=short", p.path]] },
  { id: "branch_list", desc: "list branches (remote=true also lists branches on GitHub/the remote)", params: { remote: "bool" }, risk: "read", build: (p) => [["git", "branch", "-vv", ...(p.remote ? ["-a"] : [])]] },
  { id: "remote_list", desc: "list remotes and their URLs", risk: "read", build: () => [["git", "remote", "-v"]] },
  { id: "tag_list", desc: "list tags", risk: "read", build: () => [["git", "tag", "-n", "--sort=-creatordate"]] },
  { id: "stash_list", desc: "list stashes", risk: "read", build: () => [["git", "stash", "list"]] },
  { id: "stash_show", desc: "show what a stash contains", params: { index: "int" }, risk: "read", build: (p) => [["git", "stash", "show", "-p", `stash@{${p.index ?? 0}}`]] },
  { id: "reflog", desc: "history of where HEAD has been (find lost commits)", params: { n: "int" }, risk: "read", build: (p) => [["git", "reflog", `-n${p.n || 20}`]] },
  { id: "contributors", desc: "commit count per author", risk: "read", build: () => [["git", "shortlog", "-sne", "HEAD"]] },
  { id: "whoami", desc: "show configured git user name/email", risk: "read", build: () => [["git", "config", "user.name"], ["git", "config", "user.email"]] },
  { id: "config_list", desc: "show git config", params: { global: "bool" }, risk: "read", build: (p) => [["git", "config", "--list", p.global ? "--global" : "--show-origin"]] },
  { id: "ls_files", desc: "list tracked files (pattern optional)", params: { pattern: "str" }, risk: "read", build: (p) => [["git", "ls-files", ...(p.pattern ? [p.pattern] : [])]] },
  { id: "search_code", desc: "grep tracked files for text", params: { text: "str!" }, risk: "read", build: (p) => [["git", "grep", "-n", "-I", p.text]] },
  { id: "compare_branches", desc: "commits in `to` that are not in `from` (what would merge)", params: { from: "str!", to: "str!" }, risk: "read", build: (p) => [["git", "log", "--oneline", `${p.from}..${p.to}`]] },
];
