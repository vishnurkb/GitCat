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
  const auth = matchKnownError("remote: Permission to bob/x.git denied to alice.\nfatal: unable to access", s);
  assert.match(auth.cause, /bob/);
  assert.equal(auth.steps[0].op, "gh_switch_account");
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
