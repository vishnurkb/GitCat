// GitHub operations via the `gh` CLI (already authenticated on this machine).
import path from "node:path";

export default [
  { id: "gh_status", desc: "which GitHub accounts are logged in and which is active", risk: "read", build: () => [["gh", "auth", "status"]] },
  {
    id: "gh_switch_account",
    desc: "switch the active GitHub account (user omitted = the other account)",
    params: { user: "str" },
    risk: "write",
    build: (p, ctx) => {
      const user = p.user || (ctx.snap.ghAccounts || []).find((a) => a !== ctx.snap.ghUser);
      return [["gh", "auth", "switch", "--hostname", "github.com", ...(user ? ["--user", user] : [])]];
    },
  },
  { id: "gh_login", desc: "log in to a new GitHub account (opens browser)", risk: "write", interactive: true, build: () => [["gh", "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"]] },
  { id: "gh_setup_git", desc: "make git use gh credentials for https push/pull", risk: "write", build: () => [["gh", "auth", "setup-git"]] },
  {
    id: "gh_repo_create",
    desc: "create a GitHub repo AND publish this folder to it: runs git init / first commit if needed, links it as a remote and pushes. from_current=false = empty repo only. visibility default private",
    params: { name: "str", visibility: "private|public|internal", description: "str", from_current: "bool", remote: "str" },
    risk: (p) => (p.visibility === "public" ? "danger" : "write"),
    warn: (p) => (p.visibility === "public" ? "This repository will be PUBLIC — anyone can see the code." : ""),
    build: (p, ctx) => {
      const s = ctx.snap;
      const name = p.name || path.basename(s.root || ctx.cwd).replace(/\s+/g, "-");
      const a = ["gh", "repo", "create", name, `--${p.visibility || "private"}`];
      if (p.description) a.push("--description", p.description);
      if (!(p.from_current ?? true)) return [a];
      // gh --push only pushes existing commits. A folder with no commits yet would
      // silently end up as an EMPTY GitHub repo — so make the first commit first.
      const steps = [];
      if (!s.isRepo) steps.push(["git", "init", "-b", "main"]);
      const hasFiles = !s.isRepo || s.staged?.length || s.unstaged?.length || s.untracked?.length;
      if (!s.hasCommits && hasFiles) steps.push(["git", "add", "-A"], ["git", "commit", "-m", "Initial commit"]);
      a.push("--source=.", `--remote=${p.remote || ((s.remotes || []).includes("origin") ? "github" : "origin")}`);
      if (s.hasCommits || hasFiles) a.push("--push");
      return [...steps, a];
    },
  },
  {
    id: "gh_repo_clone",
    desc: "clone a GitHub repo (owner/name or name of your own repo)",
    params: { repo: "str!", dir: "str" },
    risk: "write",
    build: (p) => [["gh", "repo", "clone", p.repo, ...(p.dir ? [p.dir] : [])]],
  },
  { id: "gh_repo_list", desc: "list GitHub repos of an owner (default you)", params: { owner: "str", limit: "int" }, risk: "read", build: (p) => [["gh", "repo", "list", ...(p.owner ? [p.owner] : []), "--limit", String(p.limit || 30)]] },
  { id: "gh_repo_view", desc: "show a GitHub repo's info. web=true opens the browser — only when the user asks to open it", params: { repo: "str", web: "bool" }, risk: "read", build: (p) => [["gh", "repo", "view", ...(p.repo ? [p.repo] : []), ...(p.web ? ["--web"] : [])]] },
  { id: "gh_repo_fork", desc: "fork a repo to your account", params: { repo: "str!", clone: "bool" }, risk: "write", build: (p) => [["gh", "repo", "fork", p.repo, `--clone=${p.clone ? "true" : "false"}`]] },
  {
    id: "gh_repo_visibility",
    desc: "change a GitHub repo to public or private",
    params: { visibility: "public|private!", repo: "str" },
    risk: "danger",
    warn: (p) => (p.visibility === "public" ? "Repository becomes PUBLIC." : "Making it private can remove stars/forks."),
    build: (p) => [["gh", "repo", "edit", ...(p.repo ? [p.repo] : []), "--visibility", p.visibility, "--accept-visibility-change-consequences"]],
  },
  {
    id: "gh_repo_delete",
    desc: "DELETE a GitHub repository permanently",
    params: { repo: "str!" },
    risk: "danger",
    warn: () => "Permanently deletes the GitHub repository, its issues and PRs. Needs the delete_repo token scope (gh auth refresh -s delete_repo).",
    build: (p) => [["gh", "repo", "delete", p.repo, "--yes"]],
  },
  {
    id: "gh_pr_create",
    desc: "open a pull request for the current branch (title omitted = fill from commits). pushes branch first if needed",
    params: { title: "str", body: "str", base: "str", draft: "bool" },
    risk: "write",
    build: (p, ctx) => {
      const steps = [];
      if (!ctx.snap.upstream && ctx.snap.branch) steps.push(["git", "push", "-u", ctx.snap.defaultRemote || "origin", ctx.snap.branch]);
      const a = ["gh", "pr", "create"];
      if (p.title) a.push("--title", p.title, "--body", p.body || "");
      else a.push("--fill");
      if (p.base) a.push("--base", p.base);
      if (p.draft) a.push("--draft");
      steps.push(a);
      return steps;
    },
  },
  { id: "gh_pr_list", desc: "list pull requests", params: { state: "open|closed|merged|all" }, risk: "read", build: (p) => [["gh", "pr", "list", "--state", p.state || "open"]] },
  { id: "gh_pr_view", desc: "show a pull request (number omitted = current branch's PR)", params: { number: "str", web: "bool" }, risk: "read", build: (p) => [["gh", "pr", "view", ...(p.number ? [p.number] : []), ...(p.web ? ["--web"] : [])]] },
  { id: "gh_pr_checkout", desc: "check out a pull request locally", params: { number: "str!" }, risk: "write", build: (p) => [["gh", "pr", "checkout", p.number]] },
  { id: "gh_pr_checks", desc: "CI check status of a PR", params: { number: "str" }, risk: "read", build: (p) => [["gh", "pr", "checks", ...(p.number ? [p.number] : [])]] },
  {
    id: "gh_pr_merge",
    desc: "merge a pull request on GitHub",
    params: { number: "str", method: "merge|squash|rebase", delete_branch: "bool" },
    risk: "danger",
    warn: () => "Merges the PR into its base branch on GitHub.",
    build: (p) => [["gh", "pr", "merge", ...(p.number ? [p.number] : []), `--${p.method || "merge"}`, ...(p.delete_branch ? ["--delete-branch"] : [])]],
  },
  { id: "gh_pr_close", desc: "close a pull request", params: { number: "str!" }, risk: "write", build: (p) => [["gh", "pr", "close", p.number]] },
  { id: "gh_issue_create", desc: "create a GitHub issue", params: { title: "str!", body: "str" }, risk: "write", build: (p) => [["gh", "issue", "create", "--title", p.title, "--body", p.body || ""]] },
  { id: "gh_issue_list", desc: "list issues", params: { state: "open|closed|all" }, risk: "read", build: (p) => [["gh", "issue", "list", "--state", p.state || "open"]] },
  { id: "gh_issue_close", desc: "close an issue", params: { number: "str!" }, risk: "write", build: (p) => [["gh", "issue", "close", p.number]] },
  {
    id: "gh_release_create",
    desc: "publish a GitHub release for a tag (notes auto-generated if none)",
    params: { tag: "str!", title: "str", notes: "str" },
    risk: "write",
    build: (p) => [["gh", "release", "create", p.tag, ...(p.title ? ["--title", p.title] : []), ...(p.notes ? ["--notes", p.notes] : ["--generate-notes"])]],
  },
  { id: "gh_run_list", desc: "recent GitHub Actions runs", risk: "read", build: () => [["gh", "run", "list", "--limit", "10"]] },
  { id: "gh_browse", desc: "open this repo on github.com in the browser", risk: "read", build: () => [["gh", "browse"]] },
];
