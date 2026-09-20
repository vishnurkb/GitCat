import { test } from "node:test";
import assert from "node:assert/strict";
import { fastRoute } from "../src/agent/router.js";
import { matchKnownError } from "../src/agent/knownErrors.js";
import { parseStatus, parseGhHosts, contextText } from "../src/agent/context.js";
import { splitArgs, fmt } from "../src/exec/run.js";
import { extractJson } from "../src/llm/index.js";
import { matchSlash, findSlash } from "../src/ui/slash.js";

test("fast router: exact phrases skip the model", () => {
  assert.deepEqual(fastRoute("status").steps, [{ op: "status", args: {} }]);
  assert.deepEqual(fastRoute("  Push!! ").steps, [{ op: "push", args: {} }]);
  assert.deepEqual(fastRoute("please commit and push").steps.map((s) => s.op), ["add", "commit", "push"]);
  assert.equal(fastRoute("commit and push my login fix"), null);
  assert.equal(fastRoute("git log --oneline -3").kind, "raw");
  assert.equal(fastRoute("!gh pr list").command, "gh pr list");
  assert.deepEqual(fastRoute("cd ../other").steps, [{ op: "cd", args: { path: "../other" } }]);
  assert.deepEqual(fastRoute('commit -m "fix: typo"').steps, [{ op: "commit", args: { message: "fix: typo" } }]);
});

test("fast router: 'switch to X' only when X is a real branch", () => {
  const snap = { branches: ["main", "dev"], remoteBranches: ["origin/feature/login"] };
  assert.deepEqual(fastRoute("switch to dev", snap).steps, [{ op: "switch", args: { branch: "dev" } }]);
  assert.deepEqual(fastRoute("checkout feature/login", snap).steps[0].args.branch, "feature/login");
  assert.equal(fastRoute("switch to account", snap), null);
});

test("known errors map to fixes", () => {
  const s = { branch: "feat", remotes: ["origin"], ghUser: "alice", ghAccounts: ["alice", "bob"], staged: [], unstaged: ["M a"], untracked: [] };
  assert.deepEqual(matchKnownError("fatal: The current branch feat has no upstream branch.", s).steps, [{ op: "push", args: {} }]);
  assert.deepEqual(
    matchKnownError(" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs", s).steps.map((x) => x.op),
    ["pull", "push"],
  );
  assert.deepEqual(matchKnownError("error: src refspec main does not match any", s).steps.map((x) => x.op), ["add", "commit"]);
  assert.equal(matchKnownError("fatal: not a git repository (or any of the parent directories): .git", s).steps[0].op, "init");
  // repo owned by the user's OTHER account -> switch to exactly that account
  const bobRepo = { ...s, defaultRemote: "origin", remoteUrls: { origin: "https://github.com/bob/x.git" } };
  const auth = matchKnownError("remote: Permission to bob/x.git denied to alice.\nfatal: unable to access", bobRepo);
  assert.match(auth.cause, /bob/);
  assert.deepEqual(auth.steps[0], { op: "gh_switch_account", args: { user: "bob" } });
  // repo doesn't exist under the active account -> never flip accounts
  const mine = { ...s, defaultRemote: "origin", remoteUrls: { origin: "https://github.com/alice/nope.git" } };
  const nf = matchKnownError("remote: Repository not found.\nfatal: repository 'https://github.com/alice/nope.git/' not found", mine);
  assert.deepEqual(nf.steps, []);
  assert.match(nf.cause, /alice\/nope doesn't exist/);
  assert.equal(matchKnownError("CONFLICT (content): Merge conflict in a.txt", s).steps.length, 0);
  assert.equal(matchKnownError("error: remote origin already exists.", s).steps, null); // cause known, model plans the fix
  assert.equal(matchKnownError("something totally new", s), null);
});

test("parseStatus reads porcelain v2", () => {
  const st = parseStatus(
    [
      "# branch.oid 1234",
      "# branch.head feat/x",
      "# branch.upstream origin/feat/x",
      "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 abc abc src/a b.js",
      "1 .M N... 100644 100644 100644 abc abc README.md",
      "2 R. N... 100644 100644 100644 abc abc R100 new.js\told.js",
      "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
      "? scratch.txt",
    ].join("\n"),
  );
  assert.equal(st.branch, "feat/x");
  assert.equal(st.upstream, "origin/feat/x");
  assert.deepEqual([st.ahead, st.behind], [2, 1]);
  assert.deepEqual(st.staged, ["M src/a b.js", "R new.js"]);
  assert.deepEqual(st.unstaged, ["M README.md"]);
  assert.deepEqual(st.conflicts, ["conflict.txt"]);
  assert.deepEqual(st.untracked, ["scratch.txt"]);
});

test("parseGhHosts finds accounts and active user", () => {
  const txt = "github.com:\n    git_protocol: https\n    users:\n        alice:\n        bob:\n            oauth_token: x\n    user: bob\n";
  assert.deepEqual(parseGhHosts(txt), { ghUser: "bob", ghAccounts: ["alice", "bob"] });
  assert.deepEqual(parseGhHosts(""), { ghUser: "", ghAccounts: [] });
});

test("contextText is compact and mentions key facts", () => {
  const t = contextText({
    isRepo: true, root: "/r", branch: "main", hasCommits: true, upstream: "", staged: [], unstaged: ["M a.js"], untracked: [],
    conflicts: [], branches: ["main", "dev"], remoteBranches: [], remotes: [], remoteUrls: {}, stashes: [], tags: [], recent: ["abc init"], ghUser: "me", ghAccounts: ["me"],
  });
  assert.match(t, /no upstream, never pushed/);
  assert.match(t, /modified: M a\.js/);
  assert.match(t, /remotes: none/);
  assert.ok(t.length < 600);
});

test("splitArgs honors quotes; fmt quotes when needed", () => {
  assert.deepEqual(splitArgs(`commit -m "fix: a b" --author='X Y'`), ["commit", "-m", "fix: a b", "--author=X Y"]);
  assert.deepEqual(splitArgs(`log ""`), ["log", ""]);
  assert.equal(fmt(["git", "commit", "-m", "fix: a b"]), 'git commit -m "fix: a b"');
});

test("extractJson survives fences and chatter", () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":{"b":"}"}}\n```'), { a: { b: "}" } });
  assert.throws(() => extractJson("no json here"));
});

test("slash menu matching", () => {
  assert.equal(matchSlash("/")[0].name, "help");
  assert.equal(matchSlash("/com")[0].name, "commit");
  assert.equal(matchSlash("/model groq").length, 0); // menu closes once args start
  assert.equal(findSlash("/model ollama qwen").arg, "ollama qwen");
  assert.equal(findSlash("/nope"), null);
});

test("router: push-status questions go to sync_check", () => {
  for (const q of ["did you push?", "did u push it", "is it pushed", "is everything on github?", "am I up to date", "is the github repo empty?"]) {
    assert.deepEqual(fastRoute(q)?.steps, [{ op: "sync_check", args: {} }], q);
  }
  assert.equal(fastRoute("push the current dir to github repo"), null);
});

test("intent guard: user's words override risky or wrong parameters", async () => {
  const { applyIntentGuards } = await import("../src/agent/intent.js");
  const { resolveStep } = await import("../src/catalog/index.js");
  const one = (req, op, args) => applyIntentGuards(req, [resolveStep({ op, args })]).steps[0];
  assert.equal(one("keep their version and finish the merge", "resolve_conflicts", { side: "ours" }).args.side, "theirs");
  assert.equal(one("keep my version", "resolve_conflicts", { side: "theirs" }).args.side, "ours");
  assert.equal(one("create bugfix/cart without switching to it", "branch_create", { name: "bugfix/cart" }).args.stay, true);
  assert.equal(one("throw away my last commit completely", "undo_commit", {}).args.discard, true);
  assert.equal(one("undo the last commit", "reset", { ref: "HEAD~1", mode: "hard" }).args.mode, "mixed");
  assert.equal(one("undo the last commit and unstage the changes too, but keep the file", "undo_commit", {}).args.unstage, true);
  assert.equal(one("bring my unfinished work back", "stash_apply", {}).op.id, "stash_pop");
  assert.equal(one("apply that stash but keep it in the list", "stash_pop", {}).op.id, "stash_apply");
  assert.equal(one("put this on github", "gh_repo_create", { visibility: "public" }).args.visibility, "private");
  assert.equal(one("put this on github as a public repo", "gh_repo_create", { visibility: "public" }).args.visibility, "public");
  assert.equal(one("push my work", "push", { force: true }).args.force, undefined);
  assert.equal(one("force push", "push", { force: true }).args.force, true);
  assert.equal(one("delete the old branch", "branch_delete", { name: "old", force: true }).args.force, undefined);
  assert.equal(one("set my email for this repo", "set_identity", { email: "a@b.c", global: true }).args.global, undefined);
  assert.equal(one("set my email globally", "set_identity", { email: "a@b.c", global: true }).args.global, true);
});

test("intent guard: merge direction, vague deletes, remote tag delete, commit-by-message", async () => {
  const { applyIntentGuards } = await import("../src/agent/intent.js");
  const { resolveStep } = await import("../src/catalog/index.js");
  const plan = (...s) => s.map(([op, args]) => resolveStep({ op, args }));
  const snap = { branch: "main", branches: ["main", "dev", "hotfix"], remoteBranches: [] };
  // model merged the WRONG way round (on dev, merging main)
  let g = applyIntentGuards("merge dev into main", plan(["switch", { branch: "dev" }], ["merge", { branch: "main" }]), snap);
  assert.deepEqual(g.steps.map((s) => [s.op.id, s.args.branch]), [["merge", "dev"]]);
  g = applyIntentGuards("merge dev into main", plan(["merge", { branch: "dev" }]), { ...snap, branch: "hotfix" });
  assert.deepEqual(g.steps.map((s) => [s.op.id, s.args.branch]), [["switch", "main"], ["merge", "dev"]]);
  // vague destructive request -> ask, run nothing
  g = applyIntentGuards("delete it", plan(["branch_delete", { name: "dev" }]), snap);
  assert.equal(g.steps.length, 0);
  assert.match(g.ask, /Name it/);
  assert.equal(applyIntentGuards("delete the dev branch", plan(["branch_delete", { name: "dev" }]), snap).steps.length, 1);
  // "delete the tag on the remote" must not push it
  g = applyIntentGuards("delete the tag v1 locally and on the remote", plan(["tag_delete", { name: "v1" }], ["push_tags", { name: "v1" }]), snap);
  assert.equal(g.steps[1].op.id, "delete_remote_tag");
  // commit named by message, model passed the branch
  g = applyIntentGuards("copy only the 'critical hotfix' commit from hotfix onto main", plan(["cherry_pick", { refs: ["hotfix"] }]), snap);
  assert.deepEqual(g.steps[0].args.refs, [":/critical hotfix"]);
});

test("extractJson repairs the model's real-world bracket slip", () => {
  const bad = '{"reply":"x","steps":[{"op":"tag_create","args":{"name":"v1"}},{"op":"push_tags","args":{}}},{"op":"gh_release_create","args":{"tag":"v1"}}],"ask":"","explain":false}';
  assert.deepEqual(extractJson(bad).steps.map((s) => s.op), ["tag_create", "push_tags", "gh_release_create"]);
  assert.deepEqual(extractJson('{"a":[1,2,],"b":{"c":"}"'), { a: [1, 2], b: { c: "}" } });
});

test("intent guard: invented commit messages are dropped, given ones kept", async () => {
  const { applyIntentGuards } = await import("../src/agent/intent.js");
  const { resolveStep } = await import("../src/catalog/index.js");
  const msg = (req, m) => applyIntentGuards(req, [resolveStep({ op: "commit", args: { message: m } })]).steps[0].args.message;
  assert.equal(msg("commit all my changes and push them", "chore: commit all changes"), undefined);
  assert.equal(msg("commit with the message 'Fix JWT bug'", "Fix JWT bug"), "Fix JWT bug");
  assert.equal(msg('commit it as "Add config"', "Add config"), "Add config");
});

test("intent guard: repo names with spaces are renamed the way GitHub will, and the user is told", async () => {
  const { applyIntentGuards } = await import("../src/agent/intent.js");
  const { resolveStep } = await import("../src/catalog/index.js");
  const g = applyIntentGuards("create a private repo with the name: DeepSeek Harness", [resolveStep({ op: "gh_repo_create", args: { name: "DeepSeek Harness" } })]);
  assert.equal(g.steps[0].args.name, "DeepSeek-Harness");
  assert.match(g.notes[0], /doesn't allow .* → creating it as DeepSeek-Harness/);
  assert.equal(applyIntentGuards("create repo my-app", [resolveStep({ op: "gh_repo_create", args: { name: "my-app" } })]).notes.length, 0);
});
