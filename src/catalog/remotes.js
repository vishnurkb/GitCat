// Remotes, fetch/pull/push, tags.

const cur = (p, ctx) => p.branch || ctx.snap.branch;

export default [
  {
    id: "push",
    desc: "push a branch (default current; sets upstream automatically on first push). force=force-with-lease",
    params: { remote: "str", branch: "str", force: "bool", tags: "bool" },
    risk: (p) => (p.force ? "danger" : "write"),
    warn: (p) => (p.force ? "Force push overwrites the remote branch history." : ""),
    build: (p, ctx) => {
      const branch = cur(p, ctx);
      const remote = p.remote || ctx.snap.upstreamRemote || ctx.snap.defaultRemote || "origin";
      const a = ["git", "push"];
      if (p.force) a.push("--force-with-lease");
      if (p.tags) a.push("--follow-tags");
      // first push of this branch (or pushing somewhere new): set upstream
      const needsUpstream = !ctx.snap.upstream || (p.branch && p.branch !== ctx.snap.branch) || (p.remote && p.remote !== ctx.snap.upstreamRemote);
      if (needsUpstream && branch) a.push("-u", remote, branch);
      else if (p.remote || p.branch) a.push(remote, branch);
      return [a];
    },
  },
  {
    id: "pull",
    desc: "pull latest changes into current branch. rebase=true keeps history linear",
    params: { remote: "str", branch: "str", rebase: "bool", allow_unrelated: "bool" },
    risk: "write",
    build: (p, ctx) => {
      const a = ["git", "pull", p.rebase ? "--rebase" : "--no-rebase"];
      if (p.allow_unrelated) a.push("--allow-unrelated-histories");
      if (p.remote || p.branch || !ctx.snap.upstream) {
        const remote = p.remote || ctx.snap.defaultRemote || "origin";
        a.push(remote, p.branch || ctx.snap.branch);
      }
      return [a];
    },
  },
  {
    id: "fetch",
    desc: "download remote updates without merging (prune removes deleted remote branches)",
    params: { remote: "str", prune: "bool" },
    risk: "read",
    build: (p) => [["git", "fetch", ...(p.remote ? [p.remote] : ["--all"]), ...(p.prune ? ["--prune"] : [])]],
  },
  {
    id: "sync",
    desc: "pull (rebase) then push the current branch",
    risk: "write",
    build: (p, ctx) => {
      const remote = ctx.snap.upstreamRemote || ctx.snap.defaultRemote || "origin";
      const b = ctx.snap.branch;
      return ctx.snap.upstream
        ? [["git", "pull", "--rebase"], ["git", "push"]]
        : [["git", "push", "-u", remote, b]];
    },
  },
  {
    id: "sync_check",
    desc: "answer 'did I/you push?', 'is it on github?', 'am I up to date?': fetches and compares the branch with its remote. Exact, no guessing",
    risk: "read",
    build: () => [{ internal: "sync_check" }],
  },
  {
    id: "set_upstream",
    desc: "make current branch track remote/branch",
    params: { remote: "str", branch: "str" },
    risk: "write",
    build: (p, ctx) => [["git", "branch", `--set-upstream-to=${p.remote || "origin"}/${p.branch || ctx.snap.branch}`]],
  },
  {
    id: "delete_remote_branch",
    desc: "delete a branch on the remote (e.g. GitHub)",
    params: { branch: "str!", remote: "str" },
    risk: "danger",
    warn: () => "The branch is deleted on the remote for everyone.",
    build: (p) => [["git", "push", p.remote || "origin", "--delete", p.branch]],
  },
  { id: "remote_add", desc: "add a remote", params: { url: "str!", name: "str" }, risk: "write", build: (p) => [["git", "remote", "add", p.name || "origin", p.url]] },
  { id: "remote_set_url", desc: "change a remote's URL", params: { url: "str!", name: "str" }, risk: "write", build: (p) => [["git", "remote", "set-url", p.name || "origin", p.url]] },
  { id: "remote_remove", desc: "remove a remote", params: { name: "str!" }, risk: "write", build: (p) => [["git", "remote", "remove", p.name]] },
  { id: "remote_rename", desc: "rename a remote", params: { from: "str!", to: "str!" }, risk: "write", build: (p) => [["git", "remote", "rename", p.from, p.to]] },
  {
    id: "tag_create",
    desc: "create a tag (annotated if message given) at ref (default HEAD)",
    params: { name: "str!", message: "str", ref: "str" },
    risk: "write",
    build: (p) => [["git", "tag", ...(p.message ? ["-a", p.name, "-m", p.message] : [p.name]), ...(p.ref ? [p.ref] : [])]],
  },
  { id: "tag_delete", desc: "delete a local tag", params: { name: "str!" }, risk: "write", build: (p) => [["git", "tag", "-d", p.name]] },
  {
    id: "push_tags",
    desc: "push tags to remote (name = one tag, omitted = all tags)",
    params: { name: "str", remote: "str" },
    risk: "write",
    build: (p) => [["git", "push", p.remote || "origin", ...(p.name ? [p.name] : ["--tags"])]],
  },
];
