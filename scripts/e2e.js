// Real-model end-to-end: plain-English requests -> real model -> real git,
// in throwaway repos, with git-state assertions after each step.
//   node scripts/e2e.js            (default provider order)
//   node scripts/e2e.js ollama     (force local)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadSettings } from "../src/config/settings.js";
import { detectProviders, modelLabel } from "../src/llm/index.js";
import { createAgent } from "../src/agent/agent.js";

const provider = process.argv[2];
const settings = { ...loadSettings(), mode: "auto" };
if (provider) settings.provider = provider;
await detectProviders(settings);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "gitcat-real-"));
const WORK = path.join(ROOT, "cat-app");
const BARE = path.join(ROOT, "cat-app-remote.git");
fs.mkdirSync(WORK);
const git = (...args) => execFileSync("git", args, { cwd: WORK, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (f, s) => fs.writeFileSync(path.join(WORK, f), s);
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: "E2E", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "E2E", GIT_COMMITTER_EMAIL: "e2e@example.com" })) process.env[k] = v;
execFileSync("git", ["init", "-q", "--bare", "-b", "main", BARE]);

let transcript = [];
const ui = {
  status() {},
  emit: (i) => transcript.push(i),
  confirm: async (r) => (transcript.push({ type: "confirm", ...r }), true),
  interactive: (f) => f(),
};
const agent = createAgent({ settings, cwd: WORK, ui });

let pass = 0;
let fail = 0;
async function step(request, check) {
  transcript = [];
  const t0 = Date.now();
  await agent.handle(request);
  const ms = Date.now() - t0;
  const ran = transcript.filter((i) => i.type === "cmd").map((c) => `${c.ok ? "✔" : "✖"} ${c.command.split("\n")[0]}`);
  let err = "";
  try {
    const r = check(transcript);
    if (r === false) err = "check returned false";
  } catch (e) {
    err = e.message;
  }
  if (err) fail++;
  else pass++;
  console.log(`${err ? "✖" : "✔"} ${request}  (${(ms / 1000).toFixed(1)}s)`);
  for (const r of ran) console.log(`     ${r}`);
  for (const i of transcript.filter((x) => ["diagnosis", "answer", "commitmsg"].includes(x.type))) console.log(`     ${i.type}: ${i.text.split("\n")[0]}`);
  const ask = transcript.find((x) => x.type === "agent" && x.ask);
  if (ask) console.log(`     asked: ${ask.text}`);
  if (err) console.log(`     FAILED: ${err}`);
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log(`GitCat real e2e — ${modelLabel(settings)} — ${ROOT}\n`);
write("index.js", "console.log('hello cat')\n");
write("README.md", "# cat app\n");

await step("make this folder a git repo and commit everything", () => {
  assert(git("rev-list", "--count", "HEAD") === "1", "expected 1 commit");
  assert(git("status", "--porcelain") === "", "tree not clean");
});
await step("create a branch called feature/login and switch to it", () => assert(git("branch", "--show-current") === "feature/login", "not on feature/login"));
write("login.js", "export function login(user) { return !!user }\n");
await step("commit my changes", () => {
  assert(git("rev-list", "--count", "HEAD") === "2", "expected 2 commits");
  const msg = git("log", "-1", "--format=%s");
  assert(/^(feat|fix|chore|docs|refactor|style|test|build|ci|perf)(\(.+\))?: .+/.test(msg), `not a conventional message: ${msg}`);
});
await step("go back to main and merge feature/login into it", () => {
  assert(git("branch", "--show-current") === "main", "not on main");
  assert(fs.existsSync(path.join(WORK, "login.js")), "login.js not merged");
});
await step(`connect this repo to ${BARE.replace(/\\/g, "/")} and push`, () => {
  assert(git("rev-parse", "HEAD") === git("rev-parse", "origin/main"), "origin/main != HEAD");
});
await step("tag this as v1.0 and push the tag", () => {
  assert(git("tag") === "v1.0", "no v1.0 tag");
  assert(execFileSync("git", ["tag"], { cwd: BARE, encoding: "utf8" }).trim() === "v1.0", "tag not on remote");
});
fs.mkdirSync(path.join(WORK, "node_modules"));
write("node_modules/junk.js", "junk\n");
git("add", ".");
git("commit", "-qm", "oops: committed node_modules");
await step("stop tracking node_modules but keep it on my disk", () => {
  assert(git("ls-files", "node_modules") === "", "node_modules still tracked");
  assert(fs.existsSync(path.join(WORK, "node_modules", "junk.js")), "node_modules deleted from disk!");
  assert(/node_modules/.test(fs.readFileSync(path.join(WORK, ".gitignore"), "utf8")), "not in .gitignore");
});
const beforeUndo = git("rev-list", "--count", "HEAD");
await step("undo the last commit but keep my changes", () => {
  assert(+git("rev-list", "--count", "HEAD") === +beforeUndo - 1, "commit not undone");
  assert(fs.existsSync(path.join(WORK, ".gitignore")), "working changes lost");
});
await step("commit everything with message 'chore: ignore node_modules'", () => assert(git("log", "-1", "--format=%s") === "chore: ignore node_modules", "wrong message"));
write("wip.js", "// half done\n");
await step("stash my work including new files", () => assert(!fs.existsSync(path.join(WORK, "wip.js")) && git("stash", "list") !== "", "not stashed"));
await step("bring back my stashed work", () => assert(fs.existsSync(path.join(WORK, "wip.js")), "not restored"));
fs.rmSync(path.join(WORK, "wip.js"));
await step("who has made the most commits here?", (t) => assert(t.some((i) => i.type === "answer" || i.type === "agent"), "no answer"));
// conflict scenario
git("switch", "-q", "-c", "dev");
write("README.md", "# cat app (dev edition)\n");
git("commit", "-qam", "docs: dev readme");
git("switch", "-q", "main");
write("README.md", "# cat app (main edition)\n");
git("commit", "-qam", "docs: main readme");
await step("merge dev into main", (t) => assert(t.some((i) => i.type === "diagnosis" && /conflict/i.test(i.text)), "conflict not diagnosed"));
await step("keep my version of the conflicted file and finish the merge", () => {
  assert(fs.readFileSync(path.join(WORK, "README.md"), "utf8").includes("main edition"), "did not keep ours");
  assert(git("status", "--porcelain") === "", "merge not finished");
  assert(!fs.existsSync(path.join(WORK, ".git", "MERGE_HEAD")), "merge still in progress");
});
await step("delete the dev branch", () => assert(!git("branch", "--format=%(refname:short)").split("\n").includes("dev"), "dev still exists"));
await step("push everything", () => assert(git("rev-parse", "HEAD") === git("rev-parse", "origin/main"), "not pushed"));
await step("what branches do I have?", (t) => assert(t.some((i) => i.type === "cmd" && i.ok), "nothing shown"));
await step("which github account am I using?", (t) =>
  assert(t.some((i) => (i.type === "cmd" && /gh auth status/.test(i.command)) || (i.type === "agent" && /vishnurkb|rishabrkb/.test(i.text))), "account not reported"),
);

console.log(`\n${pass}/${pass + fail} scenarios passed · ${agent.state.tokens.calls} model calls · ${agent.state.tokens.prompt} prompt + ${agent.state.tokens.completion} completion tokens`);
fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
