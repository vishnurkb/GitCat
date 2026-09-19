// End-to-end: the real agent drives REAL git in throwaway repos. The model is
// scripted (fake llm) so these are deterministic; scripts/e2e.js does the same
// with the real model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAgent } from "../src/agent/agent.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "gitcat-e2e-"));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function makeRepo(name, { remote = true } = {}) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  if (remote) {
    const bare = path.join(ROOT, `${name}.git`);
    git(ROOT, "init", "-q", "--bare", "-b", "main", bare);
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "-u", "origin", "main");
  }
  return dir;
}

/** Fake model: returns scripted JSON plans in order; commit-message calls get a fixed message. */
function fakeLlm(plans) {
  const calls = [];
  const fn = async (settings, messages, opts) => {
    const msgs = typeof messages === "function" ? messages("ollama") : messages;
    calls.push(msgs.at(-1).content);
    if (!opts.json) {
      const sys = msgs[0].content;
      return { text: sys.includes("Conventional Commits") ? "feat: scripted message" : "scripted answer", provider: "fake", model: "fake", ms: 1 };
    }
    const next = plans.shift();
    if (!next) throw new Error("fake llm ran out of plans");
    return { text: JSON.stringify({ reply: "ok", ask: "", explain: false, ...next }), provider: "fake", model: "fake", ms: 1 };
  };
  fn.calls = calls;
  return fn;
}

function harness(cwd, plans, { mode = "auto", approve = true } = {}) {
  const items = [];
  const confirms = [];
  const ui = {
    status() {},
    emit: (i) => items.push(i),
    confirm: async (r) => (confirms.push(r), approve),
    interactive: (f) => f(),
  };
  const llm = fakeLlm(plans);
  const agent = createAgent({ settings: { mode, provider: "ollama" }, cwd, ui, llm });
  return { agent, items, confirms, llm, cmds: () => items.filter((i) => i.type === "cmd") };
}

before(() => {
  process.env.GIT_AUTHOR_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = "t@example.com";
  process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_COMMITTER_EMAIL = "t@example.com";
});
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test("fast path: 'status' runs without calling the model", async () => {
  const dir = makeRepo("fast");
  const h = harness(dir, []);
  await h.agent.handle("status");
  assert.equal(h.llm.calls.length, 0);
  assert.equal(h.cmds()[0].command, "git status -sb");
  assert.ok(h.cmds()[0].ok);
});

test("commit and push: auto-stages, writes message, pushes", async () => {
  const dir = makeRepo("ship");
  fs.writeFileSync(path.join(dir, "b.txt"), "new\n");
  const h = harness(dir, [{ steps: [{ op: "add", args: { all: true } }, { op: "commit", args: {} }, { op: "push", args: {} }] }]);
  await h.agent.handle("commit my work and push it");
  assert.ok(h.cmds().every((c) => c.ok), JSON.stringify(h.cmds()));
  assert.equal(git(dir, "log", "-1", "--format=%s"), "feat: scripted message");
  assert.equal(git(dir, "rev-parse", "HEAD"), git(dir, "rev-parse", "origin/main"));
});

test("first push of a new branch sets upstream automatically", async () => {
  const dir = makeRepo("upstream");
  const h = harness(dir, [{ steps: [{ op: "branch_create", args: { name: "feat/x" } }] }]);
  await h.agent.handle("make a branch feat/x");
  const h2 = harness(dir, []);
  await h2.agent.handle("push");
  assert.match(h2.cmds()[0].command, /git push -u origin feat\/x/);
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "feat/x@{upstream}"), "origin/feat/x");
});

test("debugger: rejected push -> pull --rebase + push, then succeeds", async () => {
  const dir = makeRepo("reject");
  // someone else pushes first
  const other = path.join(ROOT, "reject-other");
  git(ROOT, "clone", "-q", path.join(ROOT, "reject.git"), other);
  git(other, "config", "user.email", "o@example.com");
  git(other, "config", "user.name", "Other");
  fs.writeFileSync(path.join(other, "o.txt"), "theirs\n");
  git(other, "add", ".");
  git(other, "commit", "-qm", "other work");
  git(other, "push", "-q");
  // we commit locally and try to push
  fs.writeFileSync(path.join(dir, "mine.txt"), "mine\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "my work");
  const h = harness(dir, []);
  await h.agent.handle("push");
  const diag = h.items.find((i) => i.type === "diagnosis");
  assert.ok(diag, "should diagnose");
  assert.match(diag.text, /remote has commits/);
  assert.equal(h.confirms[0].title, "Apply this fix?");
  const cmds = h.cmds().map((c) => `${c.ok ? "ok" : "FAIL"} ${c.command}`);
  assert.deepEqual(cmds, ["FAIL git push", "ok git pull --rebase", "ok git push"]);
  assert.equal(git(dir, "rev-parse", "HEAD"), git(dir, "rev-parse", "origin/main"));
  assert.ok(fs.existsSync(path.join(dir, "o.txt")));
});

test("merge conflict is explained, then 'keep mine' resolves and continues", async () => {
  const dir = makeRepo("conflict", { remote: false });
  git(dir, "switch", "-q", "-c", "dev");
  fs.writeFileSync(path.join(dir, "a.txt"), "dev version\n");
  git(dir, "commit", "-qam", "dev change");
  git(dir, "switch", "-q", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "main version\n");
  git(dir, "commit", "-qam", "main change");

  const h = harness(dir, [{ steps: [{ op: "merge", args: { branch: "dev" } }] }]);
  await h.agent.handle("merge dev");
  assert.match(h.items.find((i) => i.type === "diagnosis").text, /conflict in a\.txt/i);

  const h2 = harness(dir, [{ steps: [{ op: "resolve_conflicts", args: { side: "ours" } }, { op: "continue", args: {} }] }]);
  await h2.agent.handle("keep my version and finish the merge");
  assert.equal(h2.confirms[0].risk, "danger");
  assert.ok(h2.cmds().every((c) => c.ok), JSON.stringify(h2.cmds()));
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8").replace(/\r/g, ""), "main version\n");
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.match(git(dir, "log", "-1", "--format=%p"), / /); // merge commit has 2 parents
  assert.ok(!fs.existsSync(path.join(dir, ".git", "MERGE_HEAD")), "merge concluded");
});

test("dangerous step asks; declining runs nothing", async () => {
  const dir = makeRepo("danger", { remote: false });
  fs.writeFileSync(path.join(dir, "a.txt"), "edited\n");
  const h = harness(dir, [{ steps: [{ op: "discard", args: {} }] }], { approve: false });
  await h.agent.handle("throw away my changes");
  assert.equal(h.confirms.length, 1);
  assert.equal(h.cmds().length, 0);
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "edited\n");
});

test("yolo mode never asks; confirm mode asks for plain writes", async () => {
  const dir = makeRepo("modes", { remote: false });
  const y = harness(dir, [{ steps: [{ op: "branch_create", args: { name: "tmp", stay: true } }, { op: "branch_delete", args: { name: "tmp", force: true } }] }], { mode: "yolo" });
  await y.agent.handle("x");
  assert.equal(y.confirms.length, 0);
  assert.ok(y.cmds().every((c) => c.ok));
  const c = harness(dir, [{ steps: [{ op: "tag_create", args: { name: "v1" } }] }], { mode: "confirm", approve: true });
  await c.agent.handle("tag v1");
  assert.equal(c.confirms.length, 1);
  assert.equal(git(dir, "tag"), "v1");
});

test("gitignore + untrack keeps the file on disk", async () => {
  const dir = makeRepo("untrack", { remote: false });
  fs.writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
  git(dir, "add", ".env");
  git(dir, "commit", "-qm", "oops");
  const h = harness(dir, [
    { steps: [{ op: "gitignore_add", args: { patterns: [".env"] } }, { op: "untrack", args: { paths: [".env"] } }, { op: "commit", args: { message: "chore: untrack .env" } }] },
  ]);
  await h.agent.handle("stop tracking .env");
  assert.ok(h.cmds().every((c) => c.ok), JSON.stringify(h.cmds()));
  assert.ok(fs.existsSync(path.join(dir, ".env")));
  assert.equal(git(dir, "ls-files", ".env"), "");
  assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /^\.env$/m);
});

test("undo last commit keeps changes staged", async () => {
  const dir = makeRepo("undo", { remote: false });
  fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
  git(dir, "commit", "-qam", "second");
  const h = harness(dir, []);
  await h.agent.handle("undo last commit");
  assert.equal(git(dir, "log", "-1", "--format=%s"), "init");
  assert.match(git(dir, "status", "--porcelain"), /^M  a\.txt/);
});

test("stash then unstash round-trips including new files", async () => {
  const dir = makeRepo("stash", { remote: false });
  fs.writeFileSync(path.join(dir, "new.txt"), "wip\n");
  const h = harness(dir, []);
  await h.agent.handle("stash");
  assert.ok(!fs.existsSync(path.join(dir, "new.txt")));
  await h.agent.handle("stash pop");
  assert.ok(fs.existsSync(path.join(dir, "new.txt")));
});

test("not a repo: known error proposes init", async () => {
  const dir = path.join(ROOT, "plain");
  fs.mkdirSync(dir);
  const h = harness(dir, [], { approve: true });
  await h.agent.handle("git log");
  assert.match(h.items.find((i) => i.type === "diagnosis").text, /isn't a git repository/);
  assert.ok(fs.existsSync(path.join(dir, ".git")));
});

test("model asking a question runs nothing; question-only plans are answered", async () => {
  const dir = makeRepo("ask", { remote: false });
  const h = harness(dir, [{ steps: [], ask: "Which remote URL should I use?" }]);
  await h.agent.handle("connect to github");
  assert.equal(h.cmds().length, 0);
  assert.ok(h.items.find((i) => i.type === "agent" && i.ask));
});

test("invalid op from the model triggers one repair round", async () => {
  const dir = makeRepo("repair", { remote: false });
  const h = harness(dir, [{ steps: [{ op: "git_status_please", args: {} }] }, { steps: [{ op: "status", args: {} }] }]);
  await h.agent.handle("how are things");
  assert.equal(h.llm.calls.length, 2);
  assert.match(h.llm.calls[1], /Invalid steps/);
  assert.equal(h.cmds()[0].command, "git status -sb");
});

test("explain=true summarizes read-only output", async () => {
  const dir = makeRepo("explain", { remote: false });
  const h = harness(dir, [{ steps: [{ op: "contributors", args: {} }], explain: true }]);
  await h.agent.handle("who commits most?");
  assert.equal(h.items.at(-1).type, "answer");
});

test("raw git commands are classified and dangerous ones confirmed", async () => {
  const dir = makeRepo("raw", { remote: false });
  const h = harness(dir, [], { approve: false });
  await h.agent.handle("git reset --hard HEAD");
  assert.equal(h.confirms[0].risk, "danger");
  assert.equal(h.cmds().length, 0);
  await h.agent.handle("git log --oneline -1");
  assert.equal(h.confirms.length, 1);
  assert.ok(h.cmds()[0].ok);
});

// ---- Regressions from a real session (2026-09-19): "create a private repo and
// push this folder" created an EMPTY GitHub repo and never pushed. ----------

const FAKE_GH = path.join(ROOT, "fake-github");
function useFakeGh() {
  fs.mkdirSync(FAKE_GH, { recursive: true });
  process.env.GITCAT_GH_SHIM = path.join(import.meta.dirname, "fixtures", "fake-gh.mjs");
  process.env.FAKE_GH_DIR = FAKE_GH;
}
const remoteLog = (name) => git(ROOT, "--git-dir", path.join(FAKE_GH, `${name}.git`), "log", "--format=%s", "main");

function freshUncommittedRepo(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "t@example.com");
  fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
  fs.writeFileSync(path.join(dir, "index.js"), "console.log(1)\n");
  return dir;
}

test("regression: gh repo create on a repo with NO commits commits first and pushes", async () => {
  useFakeGh();
  const dir = freshUncommittedRepo("nocommits");
  const h = harness(dir, [{ steps: [{ op: "gh_repo_create", args: { name: "GitCatA", visibility: "private", description: "demo" } }] }]);
  await h.agent.handle("create a private repo GitCatA and push this folder to it");
  assert.ok(h.cmds().every((c) => c.ok), JSON.stringify(h.cmds()));
  assert.deepEqual(h.cmds().map((c) => c.command.split(" ").slice(0, 3).join(" ")), ["git add -A", "git commit -m", "gh repo create"]);
  assert.match(h.cmds().at(-1).command, /--push/);
  assert.equal(remoteLog("GitCatA"), "Initial commit");
});

test("regression: gh repo create from a plain folder runs git init first", async () => {
  useFakeGh();
  const dir = path.join(ROOT, "plainfolder");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  const h = harness(dir, [{ steps: [{ op: "gh_repo_create", args: { name: "GitCatB" } }] }]);
  await h.agent.handle("put this folder on github");
  assert.ok(h.cmds().every((c) => c.ok), JSON.stringify(h.cmds()));
  assert.equal(remoteLog("GitCatB"), "Initial commit");
});

test("regression: push on a branch with no commits -> add+commit fix, then the push is RETRIED", async () => {
  useFakeGh();
  const dir = freshUncommittedRepo("refspec");
  git(ROOT, "init", "-q", "--bare", "-b", "main", path.join(FAKE_GH, "GitCatC.git"));
  git(dir, "remote", "add", "origin", path.join(FAKE_GH, "GitCatC.git"));
  const h = harness(dir, [{ steps: [{ op: "push", args: {} }] }]);
  await h.agent.handle("push this to github");
  const cmds = h.cmds().map((c) => `${c.ok ? "ok" : "FAIL"} ${c.command.split(" ").slice(0, 3).join(" ")}`);
  assert.deepEqual(cmds, ["FAIL git push -u", "ok git add -A", "ok git commit -m", "ok git push -u"]);
  assert.equal(remoteLog("GitCatC"), "Initial commit");
  assert.ok(!h.items.some((i) => /NOT completed/.test(i.text || "")));
});

test("regression: 'nothing to commit' does not stop the push that follows", async () => {
  useFakeGh();
  const dir = freshUncommittedRepo("clean");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Initial commit");
  git(ROOT, "init", "-q", "--bare", "-b", "main", path.join(FAKE_GH, "GitCatD.git"));
  git(dir, "remote", "add", "origin", path.join(FAKE_GH, "GitCatD.git"));
  const h = harness(dir, [{ steps: [{ op: "add", args: { all: true } }, { op: "commit", args: { message: "Add files" } }, { op: "push", args: {} }] }]);
  await h.agent.handle("push the current dir to the github repo");
  assert.ok(h.items.some((i) => /Nothing new to commit/.test(i.text || "")));
  assert.match(h.cmds().at(-1).command, /git push -u origin main/);
  assert.ok(h.cmds().at(-1).ok);
  assert.equal(remoteLog("GitCatD"), "Initial commit");
});

test("regression: an unfinished request is reported as NOT completed", async () => {
  const dir = makeRepo("unfinished", { remote: false });
  const h = harness(dir, [{ steps: [{ op: "switch", args: { branch: "does-not-exist" } }, { op: "push", args: {} }] }, { steps: [] }]);
  await h.agent.handle("switch and push");
  const note = h.items.find((i) => /NOT completed/.test(i.text || ""));
  assert.ok(note, "must say it did not finish");
  assert.match(note.text, /Not run: push/);
});

test("sync_check answers 'did you push?' from git, not from the model", async () => {
  const dir = makeRepo("synccheck"); // pushed
  const h = harness(dir, []);
  await h.agent.handle("did you push it?");
  assert.equal(h.llm.calls.length, 0, "must not ask the model");
  assert.match(h.cmds()[0].output, /Yes — main is on origin/);
  fs.writeFileSync(path.join(dir, "n.txt"), "n\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "unpushed");
  await h.agent.handle("is it on github?");
  assert.match(h.cmds()[1].output, /1 local commit\(s\) NOT pushed/);
  const fresh = harness(freshUncommittedRepo("syncnone"), []);
  await fresh.agent.handle("did u push");
  assert.match(fresh.cmds()[0].output, /No — there are no commits yet/);
});
