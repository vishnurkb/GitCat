// Planner accuracy + latency eval against the REAL models.
//   node scripts/eval.js                 -> both providers that are available
//   node scripts/eval.js groq            -> one provider
//   node scripts/eval.js ollama qwen2.5:3b
// Scores whether the model picked the right ops (in order) with the key args.
import { loadSettings } from "../src/config/settings.js";
import { createAgent } from "../src/agent/agent.js";
import { contextText } from "../src/agent/context.js";
import { listOllamaModels, detectProviders } from "../src/llm/index.js";

const REPO = {
  isRepo: true, root: "D:\\projects\\cat-app", branch: "feature/login", hasCommits: true, upstream: "origin/feature/login", ahead: 2, behind: 0,
  staged: [], unstaged: ["M src/login.js", "M README.md"], untracked: ["src/app.js", "notes.txt"], conflicts: [], inProgress: "",
  branches: ["feature/login", "main", "dev", "bugfix/header"], remoteBranches: ["origin/main", "origin/dev", "origin/feature/login", "origin/bugfix/header"],
  remotes: ["origin"], remoteUrls: { origin: "https://github.com/vishnurkb/cat-app.git" }, stashes: ["stash@{0} On feature/login: wip styles"],
  tags: ["v1.0"], recent: ["a1b2c3d feat: login form", "d4e5f6a fix: header overlap", "0badc0d chore: init"],
  ghUser: "vishnurkb", ghAccounts: ["rishabrkb123-collab", "vishnurkb"],
};
const NOREPO = { isRepo: false, cwd: "D:\\projects\\new-thing", ghUser: "vishnurkb", ghAccounts: ["rishabrkb123-collab", "vishnurkb"] };
const MERGING = { ...REPO, branch: "main", inProgress: "merge", conflicts: ["src/login.js"], unstaged: [], untracked: [] };

// ops: expected sequence; "x?" optional; "a|b" alternatives. args: [opId, {key: value|RegExp}]
const CASES = [
  { q: "commit my changes with message 'fix header alignment' and push", ops: ["add?", "commit", "push"], args: [["commit", { message: /fix header alignment/ }]] },
  { q: "switch to the dev branch", ops: ["switch"], args: [["switch", { branch: "dev" }]] },
  { q: "go back to main", ops: ["switch"], args: [["switch", { branch: "main" }]] },
  { q: "create a branch called hotfix/payment off main", ops: ["branch_create"], args: [["branch_create", { name: "hotfix/payment", from: "main" }]] },
  { q: "delete the bugfix branch", ops: ["branch_delete"], args: [["branch_delete", { name: "bugfix/header" }]] },
  { q: "merge dev into this branch", ops: ["merge"], args: [["merge", { branch: "dev" }]] },
  { q: "undo my last commit", ops: ["undo_commit"] },
  { q: "throw away all my local changes", ops: ["discard|reset", "clean?"] }, // untracked files: clean, never untrack
  { q: "show me what i changed", ops: ["diff|status", "diff?"] },
  { q: "who has made the most commits in this repo?", ops: ["contributors|log"] },
  { q: "stash my work", ops: ["stash"] },
  { q: "bring back my stashed changes", ops: ["stash_pop|stash_apply"] },
  { q: "tag this as v1.1 and push the tag", ops: ["tag_create", "push_tags"], args: [["tag_create", { name: "v1.1" }]] },
  { q: "rename this branch to feature/auth", ops: ["branch_rename"], args: [["branch_rename", { to: "feature/auth" }]] },
  { q: "stop tracking the .env file", ops: ["gitignore_add?", "untrack", "commit?"], args: [["untrack", { paths: [".env"] }]] },
  { q: "create a private github repo called cat-app2", ops: ["gh_repo_create"], args: [["gh_repo_create", { name: "cat-app2" }]] },
  { q: "switch my github account to rishabrkb123-collab", ops: ["gh_switch_account"], args: [["gh_switch_account", { user: "rishabrkb123-collab" }]] },
  { q: "open a pull request to main", ops: ["push?", "gh_pr_create"], args: [["gh_pr_create", { base: "main" }]] },
  { q: "list open PRs", ops: ["gh_pr_list"] },
  { q: "clone vishnurkb/Palta-Player", ops: ["gh_repo_clone|clone"] },
  { q: "pull the latest changes", ops: ["pull"] },
  { q: "sync with the remote", ops: ["sync|pull", "push?"] },
  { q: "what's the difference between fetch and pull?", ops: [] },
  { q: "show the last 5 commits", ops: ["log"], args: [["log", { n: 5 }]] },
  { q: "revert the commit d4e5f6a", ops: ["revert"], args: [["revert", { ref: "d4e5f6a" }]] },
  { q: "squash my last 3 commits into one", ops: ["squash_last"], args: [["squash_last", { n: 3 }]] },
  { q: "cherry pick a1b2c3d onto dev", ops: ["switch", "cherry_pick"], args: [["switch", { branch: "dev" }], ["cherry_pick", { refs: ["a1b2c3d"] }]] },
  { q: "add a remote called upstream pointing to https://github.com/org/app.git", ops: ["remote_add"], args: [["remote_add", { name: "upstream", url: "https://github.com/org/app.git" }]] },
  { q: "change origin url to git@github.com:me/new.git", ops: ["remote_set_url"], args: [["remote_set_url", { url: "git@github.com:me/new.git" }]] },
  { q: "delete the bugfix/header branch on github", ops: ["delete_remote_branch"], args: [["delete_remote_branch", { branch: "bugfix/header" }]] },
  { q: "force push this branch", ops: ["push"], args: [["push", { force: true }]] },
  { q: "publish a release v2.0", ops: ["tag_create?", "push_tags?", "gh_release_create"], args: [["gh_release_create", { tag: "v2.0" }]] },
  { q: "commit only src/app.js with message 'feat: app shell'", ops: ["add", "commit"], args: [["add", { paths: ["src/app.js"] }], ["commit", { message: "feat: app shell" }]] },
  { q: "unstage everything", ops: ["unstage"] },
  { q: "show branches on github too", ops: ["branch_list|fetch", "branch_list?"] },
  { q: "set my git email to me@example.com", ops: ["set_identity|config_set"] },
  { q: "remove node_modules from the repo but keep it on my disk", ops: ["gitignore_add?", "untrack", "commit?"], args: [["untrack", { paths: [/node_modules/] }]] },
  { q: "restore README.md to how it was in the last commit", ops: ["restore_file|discard"] },
  { q: "i wanna see the commit graph", ops: ["log"], args: [["log", { graph: true }]] },
  { q: "create a worktree for dev in ../wt-dev", ops: ["worktree_add"], args: [["worktree_add", { branch: "dev" }]] },
  { q: "start a git bisect", ops: ["git_raw"] },
  { q: "list the github actions secrets", ops: ["gh_raw"] },
  { q: "pls psuh my chnages", ops: ["add?", "commit?", "push"] },
  { q: "save everything and send it to github", ops: ["add", "commit", "push"] },
  { q: "who am i logged in as on github", ops: ["gh_status"] },
  { q: "delete the stash", ops: ["stash_drop"] },
  { q: "make this folder a repo and commit everything", ops: ["init", "add", "commit"], ctx: NOREPO },
  { q: "put this on github as a public repo named demo", ops: ["init?", "add?", "commit?", "gh_repo_create", "push?"], args: [["gh_repo_create", { visibility: "public", name: "demo" }]], ctx: NOREPO },
  { q: "keep my version of the conflicted file", ops: ["resolve_conflicts", "continue?"], args: [["resolve_conflicts", { side: "ours" }]], ctx: MERGING },
  { q: "cancel this merge", ops: ["abort"], ctx: MERGING },
];

function matchSeq(expected, got) {
  // small backtracking matcher for optional ("x?") and alternative ("a|b") tokens
  const go = (i, j) => {
    if (i === expected.length) return j === got.length;
    const tok = expected[i];
    const opt = tok.endsWith("?");
    const alts = (opt ? tok.slice(0, -1) : tok).split("|");
    if (j < got.length && alts.includes(got[j]) && go(i + 1, j + 1)) return true;
    return opt && go(i + 1, j);
  };
  return go(0, 0);
}

function argOk(want, have) {
  if (want instanceof RegExp) return want.test(String(have ?? ""));
  if (Array.isArray(want)) return Array.isArray(have) && want.every((w) => have.some((h) => (w instanceof RegExp ? w.test(h) : h === w)));
  return have === want;
}

async function runProvider(provider, model) {
  const settings = { ...loadSettings(), provider, mode: "auto" };
  await detectProviders(settings);
  if (model) settings[provider === "groq" ? "groqModel" : "ollamaModel"] = model;
  const agent = createAgent({ settings, cwd: process.cwd(), ui: { status() {}, emit() {}, confirm: async () => false, interactive: (f) => f() } });
  const label = `${provider}:${provider === "groq" ? settings.groqModel : settings.ollamaModel}`;
  console.log(`\n=== ${label} — ${CASES.length} cases ===`);
  let pass = 0;
  const times = [];
  const fails = [];
  // warm-up call so the first case isn't penalized by model load
  try {
    await agent.plan("status", contextText(REPO));
  } catch (e) {
    console.log(`  provider unavailable: ${e.message}`);
    return null;
  }
  for (const c of CASES) {
    const t0 = Date.now();
    let plan;
    try {
      plan = await agent.plan(c.q, contextText(c.ctx || REPO));
    } catch (e) {
      plan = { steps: [], error: e.message };
    }
    const ms = Date.now() - t0;
    times.push(ms);
    const got = plan.steps.map((s) => s.op.id);
    let ok = !plan.error && matchSeq(c.ops, got);
    let why = plan.error || (ok ? "" : `ops ${JSON.stringify(got)}`);
    if (ok && c.ask === undefined && plan.ask && c.ops.length) {
      ok = false;
      why = `asked instead: ${plan.ask}`;
    }
    for (const [opId, want] of c.args || []) {
      if (!ok) break;
      const step = plan.steps.find((s) => s.op.id === opId);
      if (!step) continue; // optional op absent
      for (const [k, v] of Object.entries(want)) {
        if (!argOk(v, step.args[k])) {
          ok = false;
          why = `${opId}.${k}=${JSON.stringify(step.args[k])}`;
        }
      }
    }
    if (ok) pass++;
    else fails.push({ q: c.q, why, got: plan.steps.map((s) => `${s.op.id}${JSON.stringify(s.args)}`).join(" ") });
    process.stdout.write(ok ? "." : "x");
    if (provider === "groq") await new Promise((r) => setTimeout(r, 13000)); // free tier: 8k tokens/min
  }
  times.sort((a, b) => a - b);
  const p = (x) => times[Math.min(times.length - 1, Math.floor(times.length * x))];
  console.log(`\n  accuracy ${pass}/${CASES.length} (${Math.round((pass / CASES.length) * 100)}%)   latency p50 ${p(0.5)}ms  p90 ${p(0.9)}ms  max ${times.at(-1)}ms`);
  for (const f of fails) console.log(`  ✖ "${f.q}"  → ${f.why}\n      got: ${f.got || "(no steps)"}`);
  return { label, pass, total: CASES.length, p50: p(0.5), p90: p(0.9) };
}

const [only, model] = process.argv.slice(2);
const settings = loadSettings();
const providers = only ? [only] : [process.env.GROQ_API_KEY ? "groq" : null, (await listOllamaModels(settings)).includes(settings.ollamaModel) ? "ollama" : null].filter(Boolean);
const results = [];
for (const p of providers) results.push(await runProvider(p, model));
console.log("\nSUMMARY");
for (const r of results.filter(Boolean)) console.log(`  ${r.label.padEnd(45)} ${r.pass}/${r.total}  p50 ${r.p50}ms  p90 ${r.p90}ms`);
