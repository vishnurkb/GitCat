// User-journey test: plain-English prompts (each combining several git
// commands from a real developer's cheat-sheet) -> real model -> real git.
// Every prompt is judged by an INDEPENDENT check of the repo/remote/GitHub,
// never by what GitCat printed. Reports LIES (GitCat said "done" but the
// check failed).
//
//   node scripts/journey.js            local repo + local bare remote + GitHub section
//   node scripts/journey.js --local    skip the GitHub section (no repos created)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadSettings } from "../src/config/settings.js";
import { detectProviders, modelLabel } from "../src/llm/index.js";
import { createAgent } from "../src/agent/agent.js";

const LOCAL_ONLY = process.argv.includes("--local");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7);
const sh = (bin, args, cwd, opts = {}) => execFileSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const shOk = (bin, args, cwd) => {
  try {
    return { ok: true, out: sh(bin, args, cwd) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || ""), err: String(e.stderr || e.message) };
  }
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "gitcat-journey-"));
const W = path.join(ROOT, "my-project");
const BARE = path.join(ROOT, "team-remote.git");
const MATE = path.join(ROOT, "teammate");
fs.mkdirSync(W);
sh("git", ["init", "-q", "--bare", "-b", "main", BARE]);
const git = (...a) => sh("git", a, W);
const gitOk = (...a) => shOk("git", a, W);
const write = (f, s, dir = W) => {
  fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  fs.writeFileSync(path.join(dir, f), s);
};
const read = (f, dir = W) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r/g, "");
const mate = (...a) => sh("git", ["-c", "user.name=Teammate", "-c", "user.email=mate@example.com", ...a], MATE);
const GLOBAL_NAME = shOk("git", ["config", "--global", "user.name"]).out;
const GLOBAL_EMAIL = shOk("git", ["config", "--global", "user.email"]).out;

const settings = { ...loadSettings(), mode: "auto" };
await detectProviders(settings);
let items = [];
const ui = { status() {}, emit: (i) => items.push(i), confirm: async (r) => (items.push({ type: "confirm", ...r }), true), interactive: (f) => f() };
const agent = createAgent({ settings, cwd: W, ui });

const results = [];
let section = "";
async function step(request, check, { agentFor = agent, negative = false } = {}) {
  if (ONLY && !section.includes(ONLY)) return;
  items = [];
  const t0 = Date.now();
  await agentFor.handle(request);
  const ms = Date.now() - t0;
  const summary = items.filter((i) => i.type === "summary").at(-1);
  const claimedDone = summary?.ok === true;
  let why = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await check(items);
      why = r === true || r === undefined ? "" : String(r);
    } catch (e) {
      why = e.message;
    }
    if (!why) break;
    await new Promise((res) => setTimeout(res, 1500));
  }
  const ok = !why;
  const lie = claimedDone && !ok && !negative;
  results.push({ section, request, ok, lie, why, ms });
  console.log(`\n[${lie ? "LIE " : ok ? "PASS" : "FAIL"}] (${section}) ${request}  ${(ms / 1000).toFixed(1)}s`);
  for (const i of items) {
    if (i.type === "cmd") console.log(`     ${i.ok ? "✔" : "✖"} ${i.command.split("\n")[0].slice(0, 130)}`);
    else if (i.type === "verify") console.log(`       ${i.ok === true ? "verified" : i.ok === false ? "VERIFY FAILED" : "unverified"}: ${i.text.slice(0, 140)}`);
    else if (i.type === "agent") console.log(`     [reply] ${i.text.slice(0, 160)}`);
    else if (["diagnosis", "summary", "answer", "commitmsg", "note"].includes(i.type)) console.log(`     [${i.type}] ${i.text.split("\n")[0].slice(0, 160)}`);
    else if (i.type === "confirm") console.log(`     [confirm asked: ${i.risk}] ${i.commands.join(" ; ").slice(0, 120)}`);
  }
  if (!ok) console.log(`     ✖ CHECK: ${why}`);
}
const expect = (cond, msg) => (cond ? true : msg);
const ran = (it, re) => it.some((i) => i.type === "cmd" && i.ok && re.test(i.command));
const said = (it) => it.filter((i) => ["agent", "answer", "summary", "diagnosis"].includes(i.type) || i.type === "cmd").map((i) => `${i.text || ""} ${i.output || ""}`).join("\n");
const noWrites = (it) => !it.some((i) => i.type === "cmd" && /git (commit|push|reset|branch -D|branch -d|rm|clean|restore|merge|rebase|stash|tag -d)|gh (repo|pr|issue|release) (create|delete|merge|close)/.test(i.command));
const headMsg = () => git("log", "-1", "--format=%s");
const remoteSha = (branch) => (shOk("git", ["ls-remote", BARE, `refs/heads/${branch}`], W).out.split(/\s+/)[0] || "");
const branchesLocal = () => git("branch", "--format=%(refname:short)").split("\n").filter(Boolean);

console.log(`GitCat user-journey — ${modelLabel(settings)}\nworkdir: ${ROOT}`);
const t0 = Date.now();

// ---------------------------------------------------------------- 1. setup
section = "1 setup/init";
write("app.py", 'PORT = 5000\nJWT_SECRET = "dev"\n\ndef login(user):\n    return bool(user)\n');
write("README.md", "# my project\n");
await step("turn this folder into a git repo, add everything and commit it with the message 'Initial project setup'", () => {
  if (!fs.existsSync(path.join(W, ".git"))) return "no .git";
  return expect(headMsg() === "Initial project setup", `HEAD message is "${headMsg()}"`);
});
await step("set my git name to 'Vishnu Test' and email to vishnu@example.com for this repo only, then show me my git identity", () => {
  if (git("config", "--local", "user.name") !== "Vishnu Test") return `local user.name = ${gitOk("config", "--local", "user.name").out}`;
  if (git("config", "--local", "user.email") !== "vishnu@example.com") return "local email not set";
  if (shOk("git", ["config", "--global", "user.name"]).out !== GLOBAL_NAME) return "GLOBAL user.name was changed!";
  return expect(shOk("git", ["config", "--global", "user.email"]).out === GLOBAL_EMAIL, "GLOBAL email was changed!");
});
await step("what's my default branch name setting and which branch am I on?", (it) => expect(noWrites(it) && it.some((i) => i.type === "cmd" && i.ok), "should only read"));

// ---------------------------------------------------------------- 2. inspect + staging
section = "2 status/diff/staging";
write("app.py", 'PORT = 8000\nJWT_SECRET = "dev"\n\ndef login(user):\n    return bool(user)\n');
write("config.py", "DEBUG = True\n");
await step("what did I change? show me the diff too", (it) => expect(ran(it, /git (status|diff)/) && noWrites(it), "expected status/diff, read-only"));
await step("stage only app.py, then show me what's staged", (it) => {
  const staged = git("diff", "--cached", "--name-only");
  if (staged !== "app.py") return `staged = [${staged}]`;
  return expect(ran(it, /diff --staged|diff --cached|status/), "didn't show staged changes");
});
await step("actually unstage it, I don't want to commit it yet", () => expect(git("diff", "--cached", "--name-only") === "" && /8000/.test(read("app.py")), "still staged or edits lost"));
await step("commit just app.py with the message 'Fix JWT authentication bug'", () => {
  if (headMsg() !== "Fix JWT authentication bug") return `HEAD = "${headMsg()}"`;
  if (git("show", "--name-only", "--format=", "HEAD") !== "app.py") return `commit contains: ${git("show", "--name-only", "--format=", "HEAD")}`;
  return expect(git("status", "--porcelain").includes("?? config.py"), "config.py should still be untracked");
});

// ---------------------------------------------------------------- 3. history
section = "3 history/search";
await step("show me the history as a graph", (it) => expect(ran(it, /git log.*--graph/) && noWrites(it), "no graph log"));
await step("find commits whose message mentions JWT", (it) => expect(it.some((i) => i.type === "cmd" && /JWT/i.test(i.output || "")), "JWT commit not listed"));
await step("which commits added or removed the text JWT_SECRET?", (it) => expect(ran(it, /log.*(-SJWT_SECRET|-GJWT_SECRET|JWT_SECRET)/) || it.some((i) => i.type === "cmd" && /Initial project setup/.test(i.output || "")), "no pickaxe search"));
await step("who last changed each line of app.py?", (it) => expect(ran(it, /git blame.*app\.py/), "no blame"));
await step("show me the details of the previous commit", (it) => expect(ran(it, /git show/) && noWrites(it), "no show"));

// ---------------------------------------------------------------- 4. remote + push
section = "4 remote/push";
await step(`connect this repo to ${BARE.replace(/\\/g, "/")} as origin and push main`, () => expect(remoteSha("main") === git("rev-parse", "HEAD"), "remote main != local"));
await step("did you push it?", (it) => expect(/Yes/.test(said(it)) && !/✖ No/.test(said(it)), `should say yes: ${said(it).slice(0, 200)}`));
await step("show me details about the origin remote", (it) => expect(ran(it, /remote (show|-v)/), "no remote info"));

// ---------------------------------------------------------------- 5. branches
section = "5 branches";
await step("create a feature/login branch, switch to it, add config.py and commit it as 'Add config', then push the branch", () => {
  if (!branchesLocal().includes("feature/login")) return "no feature/login";
  if (git("log", "-1", "--format=%s", "feature/login") !== "Add config") return "commit missing on feature/login";
  return expect(remoteSha("feature/login") === git("rev-parse", "feature/login"), "feature/login not pushed");
});
await step("what commits does feature/login have that main doesn't?", (it) => expect(it.some((i) => i.type === "cmd" && /Add config/.test(i.output || "")), "Add config not listed"));
await step("go back to main and merge feature/login into it", () => expect(git("branch", "--show-current") === "main" && fs.existsSync(path.join(W, "config.py")), "not merged"));
await step("push main", () => expect(remoteSha("main") === git("rev-parse", "main"), "main not pushed"));
await step("delete the feature/login branch both locally and on the remote", () => expect(!branchesLocal().includes("feature/login") && !remoteSha("feature/login"), "still exists somewhere"));
await step("create a branch called bugfix/cart without switching to it, then rename it to bugfix/checkout", () => {
  const b = branchesLocal();
  return expect(b.includes("bugfix/checkout") && !b.includes("bugfix/cart") && git("branch", "--show-current") === "main", `branches: ${b.join(",")} on ${git("branch", "--show-current")}`);
});
await step("list all branches including the remote ones", (it) => expect(ran(it, /git branch.*(-a|-r)/), "no -a listing"));

// ---------------------------------------------------------------- 6. stash workflow
section = "6 stash";
/** Start a section from a clean, committed main (earlier failures must not cascade). */
function checkpoint(branch = "main") {
  for (const f of [".git/MERGE_HEAD", ".git/rebase-merge", ".git/CHERRY_PICK_HEAD"]) if (fs.existsSync(path.join(W, f))) shOk("git", ["merge", "--abort"], W), shOk("git", ["rebase", "--abort"], W), shOk("git", ["cherry-pick", "--abort"], W);
  if (git("branch", "--show-current") !== branch) shOk("git", ["switch", "-q", branch], W);
  if (git("status", "--porcelain")) {
    git("add", "-A");
    shOk("git", ["commit", "-qm", "harness checkpoint"], W);
  }
  shOk("git", ["stash", "clear"], W);
}
checkpoint();
write("app.py", read("app.py") + "\n# WIP payment\n");
await step("I have unfinished work but need to jump to bugfix/checkout. Save my work so I can switch", () => expect(git("stash", "list") !== "" && ["main", "bugfix/checkout"].includes(git("branch", "--show-current")), `stash=${git("stash", "list")} branch=${git("branch", "--show-current")}`));
await step("ok go back to main and bring my unfinished work back", () => expect(git("branch", "--show-current") === "main" && read("app.py").includes("WIP payment") && git("stash", "list") === "", `branch=${git("branch", "--show-current")} wip=${read("app.py").includes("WIP payment")} stashes=${git("stash", "list")}`));
await step("stash it again with the name 'payment work' and show me my stashes", (it) => expect(/payment work/.test(git("stash", "list")) && ran(it, /stash list/), "named stash missing"));
await step("apply that stash but keep it in the list", () => expect(read("app.py").includes("WIP payment") && git("stash", "list") !== "", "apply failed"));
await step("throw away my changes to app.py and delete all stashes", () => expect(!read("app.py").includes("WIP payment") && git("stash", "list") === "", "not cleaned"));

// ---------------------------------------------------------------- 7. conflicts
section = "7 conflicts";
checkpoint();
const conflictSetup = (branch, theirs, ours) => {
  git("switch", "-q", "-c", branch);
  write("app.py", read("app.py").replace(/PORT = \d+/, `PORT = ${theirs}`));
  git("commit", "-qam", `${branch} port ${theirs}`);
  git("switch", "-q", "main");
  write("app.py", read("app.py").replace(/PORT = \d+/, `PORT = ${ours}`));
  git("commit", "-qam", `main port ${ours}`);
};
conflictSetup("dev", 9000, 7000);
await step("merge dev into main", (it) => expect(it.some((i) => i.type === "diagnosis" && /conflict/i.test(i.text)) && !it.some((i) => i.type === "summary" && i.ok === true), "conflict not reported honestly"), { negative: true });
await step("keep their version of the conflicted file and finish the merge", () => {
  if (fs.existsSync(path.join(W, ".git", "MERGE_HEAD"))) return "merge still in progress";
  return expect(read("app.py").includes("PORT = 9000"), `app.py: ${read("app.py").split("\n")[0]}`);
});
checkpoint();
conflictSetup("dev2", 1111, 2222);
const beforeAbort = git("rev-parse", "HEAD");
await step("merge dev2", (it) => expect(it.some((i) => i.type === "diagnosis" && /conflict/i.test(i.text)), "conflict not reported"), { negative: true });
await step("never mind, cancel that merge", () => expect(!fs.existsSync(path.join(W, ".git", "MERGE_HEAD")) && git("rev-parse", "HEAD") === beforeAbort && git("status", "--porcelain") === "", "merge not aborted cleanly"));

// ---------------------------------------------------------------- 8. rebase
section = "8 rebase";
checkpoint();
git("switch", "-q", "-c", "feature/rebase", "HEAD~2");
write("rebase.txt", "feature work\n");
git("add", ".");
git("commit", "-qm", "feature work");
git("switch", "-q", "main");
await step("update the feature/rebase branch with the latest main using rebase", () => {
  const ok = gitOk("merge-base", "--is-ancestor", "main", "feature/rebase").ok;
  const merges = git("rev-list", "--merges", "main..feature/rebase");
  return expect(ok && !merges && !fs.existsSync(path.join(W, ".git", "rebase-merge")), "feature/rebase not rebased onto main");
});

// ---------------------------------------------------------------- 9. undo family
section = "9 undo/reset/revert/amend";
checkpoint();
write("undo.txt", "1\n");
git("add", "undo.txt");
git("commit", "-qm", "undo me");
let before = git("rev-parse", "HEAD~1");
await step("undo my last commit but keep the changes staged", () => expect(git("rev-parse", "HEAD") === before && git("diff", "--cached", "--name-only").includes("undo.txt"), "soft undo failed"));
checkpoint();
write("undo2.txt", "2\n");
git("add", "undo2.txt");
git("commit", "-qm", "undo me again");
before = git("rev-parse", "HEAD~1");
await step("undo the last commit and unstage the changes too, but keep the file", () => expect(git("rev-parse", "HEAD") === before && git("diff", "--cached", "--name-only") === "" && fs.existsSync(path.join(W, "undo2.txt")), "mixed reset failed"));
checkpoint();
write("doomed.txt", "doomed\n");
git("add", "doomed.txt");
git("commit", "-qm", "doomed commit");
const doomed = git("rev-parse", "HEAD");
before = git("rev-parse", "HEAD~1");
await step("throw away my last commit completely, I don't want those changes", (it) => {
  if (!it.some((i) => i.type === "confirm" && i.risk === "danger")) return "dangerous op ran without asking";
  return expect(git("rev-parse", "HEAD") === before && !fs.existsSync(path.join(W, "doomed.txt")), "hard reset failed");
});
await step("oops I needed that commit 'doomed commit' — find it in the reflog and restore it", () => expect(git("rev-parse", "HEAD") === doomed, `HEAD ${git("rev-parse", "--short", "HEAD")} != ${doomed.slice(0, 7)}`));
await step("revert the commit 'doomed commit' and push main", () => {
  if (!/Revert "doomed commit"/.test(headMsg())) return `HEAD is "${headMsg()}"`;
  if (fs.existsSync(path.join(W, "doomed.txt"))) return "doomed.txt still present";
  return expect(remoteSha("main") === git("rev-parse", "HEAD"), "revert not pushed");
});
checkpoint();
write("feature2.txt", "x\n");
git("add", "feature2.txt");
git("commit", "-qm", "Add feature two");
write("notes.md", "notes\n");
const amendCount = git("rev-list", "--count", "HEAD");
await step("I forgot to include notes.md in my last commit — add it to that commit without changing the message", () => {
  const files = git("show", "--name-only", "--format=", "HEAD");
  if (!files.includes("notes.md")) return `HEAD files: ${files}`;
  if (headMsg() !== "Add feature two") return `message changed: ${headMsg()}`;
  return expect(git("rev-list", "--count", "HEAD") === amendCount, "made a new commit instead of amending");
});
checkpoint();
const readmeBefore = read("README.md");
write("README.md", "# broken readme\n");
await step("discard my changes to README.md", () => expect(read("README.md") === readmeBefore, "README not restored"));
checkpoint();
const old = git("show", "HEAD~3:app.py").replace(/\r/g, "");
await step("bring back app.py as it was 3 commits ago", () => expect(read("app.py").trim() === old.trim(), "app.py not restored to HEAD~3"));
checkpoint();

// ---------------------------------------------------------------- 10. tags + ignore
section = "10 tags/.gitignore/secrets";
checkpoint();
await step("tag the current commit as v1.0.0 with the message 'Version 1.0.0' and push that tag", () => {
  const t = gitOk("cat-file", "-t", "v1.0.0");
  if (t.out !== "tag") return "not an annotated tag";
  return expect(shOk("git", ["ls-remote", "--tags", BARE, "v1.0.0"], W).out.includes("v1.0.0"), "tag not on remote");
});
await step("delete the tag v1.0.0 locally and on the remote", () => expect(!gitOk("rev-parse", "--verify", "--quiet", "refs/tags/v1.0.0").ok && !shOk("git", ["ls-remote", "--tags", BARE, "v1.0.0"], W).out, "tag still exists"));
write(".env", "API_KEY=super-secret\n");
git("add", ".env");
git("commit", "-qm", "oops add env");
await step("I accidentally committed .env — stop tracking it, add it to .gitignore, commit that and push", () => {
  if (gitOk("cat-file", "-e", "HEAD:.env").ok) return ".env still in HEAD";
  if (!/^\.env$/m.test(read(".gitignore"))) return ".env not in .gitignore";
  if (!fs.existsSync(path.join(W, ".env"))) return ".env deleted from disk!";
  return expect(remoteSha("main") === git("rev-parse", "HEAD"), "not pushed");
});

// ---------------------------------------------------------------- 11. team sync
section = "11 team sync (fetch/pull/push)";
checkpoint();
git("push", "-q");
sh("git", ["clone", "-q", BARE, MATE]);
write("mate.txt", "teammate\n", MATE);
mate("add", ".");
mate("commit", "-qm", "teammate change");
mate("push", "-q");
mate("push", "-q", "origin", "HEAD:refs/heads/tmp-branch");
mate("push", "-q", "origin", "--delete", "tmp-branch");
write("README.md", "# my project\n\nlocal edit\n");
await step("pull the latest changes from the team", () => expect(fs.existsSync(path.join(W, "mate.txt")) && read("README.md").includes("local edit"), "not pulled or local edit lost"));
git("checkout", "-q", "--", "README.md");
write("mate2.txt", "again\n", MATE);
mate("add", ".");
mate("commit", "-qm", "teammate change 2");
mate("push", "-q");
write("mine.txt", "mine\n");
git("add", "mine.txt");
git("commit", "-qm", "my change");
await step("push my work", () => {
  if (remoteSha("main") !== git("rev-parse", "HEAD")) return "not pushed";
  return expect(fs.existsSync(path.join(W, "mate2.txt")), "teammate change not integrated");
});
await step("fetch everything and clean up remote branches that were deleted", (it) => expect(ran(it, /fetch.*--prune|remote prune/), "no prune"));
write("local-only.txt", "x\n");
git("add", ".");
git("commit", "-qm", "not pushed yet");
await step("is everything pushed?", (it) => expect(/NOT|No/.test(said(it)) && !/✔ Yes/.test(said(it)), `should say not pushed: ${said(it).slice(0, 150)}`), { negative: true });
await step("sync with the remote", () => expect(remoteSha("main") === git("rev-parse", "HEAD"), "not synced"));

// ---------------------------------------------------------------- 12. cherry-pick
section = "12 cherry-pick";
checkpoint();
git("switch", "-q", "-c", "hotfix");
write("hotfix.txt", "fix\n");
git("add", ".");
git("commit", "-qm", "critical hotfix");
write("other.txt", "not wanted\n");
git("add", ".");
git("commit", "-qm", "unrelated work");
git("switch", "-q", "main");
await step("copy only the 'critical hotfix' commit from the hotfix branch onto main", () => expect(fs.existsSync(path.join(W, "hotfix.txt")) && !fs.existsSync(path.join(W, "other.txt")), "wrong cherry-pick"));

// ---------------------------------------------------------------- 13. advanced
section = "13 advanced (clone/worktree/archive/alias/notes/bisect/health)";
checkpoint();
await step(`clone ${BARE.replace(/\\/g, "/")} into a folder called shallow-copy with only the latest commit of main`, () => {
  const dir = path.join(W, "shallow-copy");
  if (!fs.existsSync(path.join(dir, ".git"))) return "no clone";
  return expect(sh("git", ["rev-list", "--count", "HEAD"], dir) === "1", "not shallow");
});
fs.rmSync(path.join(W, "shallow-copy"), { recursive: true, force: true });
await step("create a worktree for the bugfix/checkout branch in ../wt-checkout", () => expect(fs.existsSync(path.join(ROOT, "wt-checkout", ".git")), "no worktree"));
await step("export the current code as a zip file called release.zip", () => expect(fs.existsSync(path.join(W, "release.zip")), "no zip"));
fs.rmSync(path.join(W, "release.zip"), { force: true });
await step("create a git alias st for status, only for this repo", () => expect(gitOk("config", "--local", "alias.st").out === "status" && shOk("git", ["config", "--global", "alias.st"]).out === shOk("git", ["config", "--global", "alias.st"]).out, "alias not set locally"));
await step("add a git note 'reviewed by QA' to the latest commit", () => expect(/reviewed by QA/.test(gitOk("notes", "show", "HEAD").out), "no note"));
await step("check the repository's health and how much space it uses", (it) => expect(ran(it, /fsck|count-objects/) && noWrites(it), "no health check"));
await step("rename the remote origin to upstream", () => expect(gitOk("remote", "get-url", "upstream").ok && !gitOk("remote", "get-url", "origin").ok, "not renamed"));
await step("rename it back to origin", () => expect(gitOk("remote", "get-url", "origin").ok, "origin missing"));

// ---------------------------------------------------------------- 14. judgement
section = "14 judgement (vague/unsafe/chat/hinglish)";
checkpoint();
shOk("git", ["push", "-q"], W);
const headBefore = git("rev-parse", "HEAD");
await step("delete it", (it) => expect(noWrites(it) && git("rev-parse", "HEAD") === headBefore, "did something destructive on a vague request"), { negative: true });
await step("what's the difference between git fetch and git pull?", (it) => expect(noWrites(it) && it.some((i) => i.type === "agent" && /fetch/i.test(i.text)), "no answer or ran writes"));
await step("hi", (it) => expect(!it.some((i) => i.type === "cmd"), "ran commands for a greeting"));
write("hinglish.txt", "namaste\n");
await step("mera saara code commit karke push kar do", () => expect(remoteSha("main") === git("rev-parse", "HEAD") && gitOk("cat-file", "-e", "HEAD:hinglish.txt").ok, "not committed+pushed"));
await step("pls psuh evrything", () => expect(remoteSha("main") === git("rev-parse", "HEAD"), "typo request failed"));

// ---------------------------------------------------------------- 15. not a repo
section = "15 not a repo";
const plain = path.join(ROOT, "plain-folder");
fs.mkdirSync(plain);
const plainAgent = createAgent({ settings, cwd: plain, ui });
await step("push my code", (it) => expect(!it.some((i) => i.type === "summary" && i.ok === true), "claimed success in a folder that isn't a repo"), { agentFor: plainAgent, negative: true });

// ---------------------------------------------------------------- 16. GitHub (real)
if (!LOCAL_ONLY) {
  section = "16 GitHub";
  const OWNER = sh("gh", ["api", "user", "--jq", ".login"]);
  const REPO = `gitcat-journey-${Date.now().toString(36)}`;
  const G = path.join(ROOT, REPO);
  fs.mkdirSync(G);
  write("README.md", `# ${REPO}\n\nGitCat journey test repo.\n`, G);
  write("main.py", "print('hello')\n", G);
  const gAgent = createAgent({ settings, cwd: G, ui });
  const api = (p) => {
    try {
      return JSON.parse(sh("gh", ["api", p]));
    } catch {
      return null;
    }
  };
  const ghSha = (b) => api(`repos/${OWNER}/${REPO}/branches/${b}`)?.commit?.sha;
  await step(`put this folder on github as a private repo called ${REPO} with a short description`, () => {
    const r = api(`repos/${OWNER}/${REPO}`);
    if (!r) return "repo missing";
    if (!r.private) return "not private";
    return expect(ghSha("main") && ghSha("main") === sh("git", ["rev-parse", "HEAD"], G), "code not on GitHub");
  }, { agentFor: gAgent });
  write("feature.py", "def feature():\n    return 42\n", G);
  await step("create a branch feature/journey, commit this new file there, push it and open a pull request into main titled 'Journey PR'", () => {
    const prs = api(`repos/${OWNER}/${REPO}/pulls?state=open`) || [];
    return expect(prs.some((p) => p.head.ref === "feature/journey" && p.title === "Journey PR"), `no PR (open: ${prs.map((p) => p.title).join(",")})`);
  }, { agentFor: gAgent });
  await step("what pull requests are open?", (it) => expect(it.some((i) => i.type === "cmd" && /Journey PR/.test(i.output || "")), "PR not listed"), { agentFor: gAgent });
  await step("merge it and delete the branch", () => {
    const pr = (api(`repos/${OWNER}/${REPO}/pulls?state=all`) || []).find((p) => p.head.ref === "feature/journey");
    return expect(pr?.merged_at, "PR not merged");
  }, { agentFor: gAgent });
  await step("go back to main and pull", () => expect(fs.existsSync(path.join(G, "feature.py")) && sh("git", ["branch", "--show-current"], G) === "main", "not updated"), { agentFor: gAgent });
  await step("create an issue titled 'Journey issue' saying the login button is broken", () => {
    const iss = api(`repos/${OWNER}/${REPO}/issues?state=all`) || [];
    return expect(iss.some((i) => i.title === "Journey issue" && !i.pull_request), "no issue");
  }, { agentFor: gAgent });
  await step("close that issue", () => {
    const iss = (api(`repos/${OWNER}/${REPO}/issues?state=all`) || []).find((i) => i.title === "Journey issue");
    return expect(iss?.state === "closed", `issue state ${iss?.state}`);
  }, { agentFor: gAgent });
  await step("tag v1.0.0, push the tag and publish a github release for it", () => expect(api(`repos/${OWNER}/${REPO}/releases/tags/v1.0.0`)?.tag_name === "v1.0.0", "no release"), { agentFor: gAgent });
  await step(`clone my repo ${REPO} into a folder called cloned-copy`, () => expect(fs.existsSync(path.join(G, "cloned-copy", ".git")), "not cloned"), { agentFor: gAgent });
  await step("is it all on github?", (it) => expect(/Yes/.test(said(it)), `said: ${said(it).slice(0, 120)}`), { agentFor: gAgent });
  console.log(`\n(GitHub test repo left on the account: ${OWNER}/${REPO})`);
}

// ---------------------------------------------------------------- report
const lies = results.filter((r) => r.lie);
const fails = results.filter((r) => !r.ok);
console.log("\n================ JOURNEY RESULT ================");
console.log(`${results.length - fails.length}/${results.length} prompts did the right thing (independently checked) in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
console.log(`LIES (said done, check failed): ${lies.length}`);
for (const f of fails) console.log(`  ✖ [${f.section}] ${f.request}\n      → ${f.why}`);
fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(lies.length ? 2 : fails.length ? 1 : 0);
