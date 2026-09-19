import { test } from "node:test";
import assert from "node:assert/strict";
import { OPS, resolveStep, buildCommands, catalogText } from "../src/catalog/index.js";
import { classifyRaw } from "../src/catalog/risk.js";
import { parseSpec } from "../src/catalog/params.js";

const snap = {
  isRepo: true, root: "/r", branch: "main", upstream: "origin/main", upstreamRemote: "origin", defaultRemote: "origin",
  remotes: ["origin"], hasCommits: true, staged: [], unstaged: [], untracked: [], conflicts: ["a.txt"], inProgress: "merge",
  ghUser: "alice", ghAccounts: ["alice", "bob"],
};
const ctx = { cwd: "/r", snap };

// fill every required param with a plausible value
function sampleArgs(op) {
  const a = {};
  for (const [name, spec] of Object.entries(op.params || {})) {
    const s = parseSpec(spec);
    if (!s.required) continue;
    a[name] = s.type === "int" ? 2 : s.type === "list" ? ["x.txt"] : s.type === "bool" ? true : s.type === "enum" ? s.values[0] : "x";
  }
  return a;
}

test("every op builds valid argv arrays with required args", () => {
  const ids = new Set();
  for (const op of OPS) {
    assert.ok(!ids.has(op.id), `duplicate op id ${op.id}`);
    ids.add(op.id);
    const step = resolveStep({ op: op.id, args: sampleArgs(op) });
    assert.ok(!step.error, `${op.id}: ${step.error}`);
    assert.ok(["read", "write", "danger"].includes(step.risk), `${op.id} risk ${step.risk}`);
    const cmds = buildCommands(step, ctx);
    assert.ok(cmds.length > 0, `${op.id} built nothing`);
    for (const c of cmds) {
      if (c.internal) continue;
      assert.ok(["git", "gh"].includes(c[0]), `${op.id} bin ${c[0]}`);
      for (const part of c) assert.equal(typeof part, "string", `${op.id} non-string arg ${part}`);
    }
  }
  assert.ok(OPS.length >= 80, `catalog has ${OPS.length} ops`);
});

test("missing required args and unknown ops are rejected", () => {
  assert.match(resolveStep({ op: "branch_create", args: {} }).error, /needs: name/);
  assert.match(resolveStep({ op: "rm_rf_everything" }).error, /unknown operation/);
  // commit message is optional because we auto-write it
  assert.ok(!resolveStep({ op: "commit", args: {} }).error);
});

test("arg coercion: strings to lists/bools/ints, bad enum dropped", () => {
  const s = resolveStep({ op: "untrack", args: { paths: "node_modules, .env" } });
  assert.deepEqual(s.args.paths, ["node_modules", ".env"]);
  const r = resolveStep({ op: "reset", args: { mode: "HARD", ref: "HEAD~1" } });
  assert.equal(r.args.mode, "hard");
  assert.equal(r.risk, "danger");
  assert.equal(resolveStep({ op: "reset", args: { mode: "nuke" } }).args.mode, undefined);
  assert.equal(resolveStep({ op: "log", args: { n: "5" } }).args.n, 5);
});

test("push sets upstream only when needed", () => {
  const push = (args, s) => buildCommands(resolveStep({ op: "push", args }), { cwd: "/r", snap: { ...snap, ...s } })[0];
  assert.deepEqual(push({}, {}), ["git", "push"]);
  assert.deepEqual(push({}, { upstream: "", upstreamRemote: "", branch: "feat/x" }), ["git", "push", "-u", "origin", "feat/x"]);
  assert.deepEqual(push({ force: true }, {}), ["git", "push", "--force-with-lease"]);
  assert.equal(resolveStep({ op: "push", args: { force: true } }).risk, "danger");
});

test("commit builds -m with message, --no-edit on bare amend", () => {
  assert.deepEqual(buildCommands(resolveStep({ op: "commit", args: { message: "feat: x", all: true } }), ctx)[0], ["git", "commit", "-a", "-m", "feat: x"]);
  assert.deepEqual(buildCommands(resolveStep({ op: "commit", args: { amend: true } }), ctx)[0], ["git", "commit", "--amend", "--no-edit"]);
});

test("gh_repo_create links current folder, defaults private, public is dangerous", () => {
  const s = resolveStep({ op: "gh_repo_create", args: { name: "my-app" } });
  assert.equal(s.risk, "write");
  const [cmd] = buildCommands(s, { cwd: "/r", snap: { ...snap, remotes: [] } });
  assert.deepEqual(cmd, ["gh", "repo", "create", "my-app", "--private", "--source=.", "--remote=origin", "--push"]);
  assert.equal(resolveStep({ op: "gh_repo_create", args: { visibility: "public" } }).risk, "danger");
  // origin already taken -> use a different remote name instead of failing
  const [cmd2] = buildCommands(s, ctx);
  assert.ok(cmd2.includes("--remote=github"));
});

test("gh_switch_account picks the other account when none given", () => {
  const [cmd] = buildCommands(resolveStep({ op: "gh_switch_account", args: {} }), ctx);
  assert.deepEqual(cmd.slice(-2), ["--user", "bob"]);
});

test("abort/continue detect the in-progress operation", () => {
  assert.deepEqual(buildCommands(resolveStep({ op: "abort", args: {} }), ctx)[0], ["git", "merge", "--abort"]);
  assert.deepEqual(buildCommands(resolveStep({ op: "continue", args: {} }), { cwd: "/r", snap: { ...snap, inProgress: "rebase" } })[0], ["git", "rebase", "--continue"]);
  assert.deepEqual(buildCommands(resolveStep({ op: "resolve_conflicts", args: { side: "theirs" } }), ctx), [
    ["git", "checkout", "--theirs", "--", "a.txt"],
    ["git", "add", "--", "a.txt"],
    ["git", "commit", "--no-edit"], // all conflicts resolved -> merge concluded
  ]);
  assert.deepEqual(buildCommands(resolveStep({ op: "continue", args: {} }), { cwd: "/r", snap: { ...snap, inProgress: "" } })[0], ["git", "status", "-sb"]);
});

test("raw command risk classification", () => {
  const c = (s) => classifyRaw(s.split(" "));
  assert.equal(c("git status"), "read");
  assert.equal(c("git log --oneline -5"), "read");
  assert.equal(c("git reset --hard HEAD~1"), "danger");
  assert.equal(c("git push --force origin main"), "danger");
  assert.equal(c("git push -f"), "danger");
  assert.equal(c("git clean -fd"), "danger");
  assert.equal(c("git clean -n"), "write");
  assert.equal(c("git branch -D old"), "danger");
  assert.equal(c("git commit -m x"), "write");
  assert.equal(c("gh repo delete me/x --yes"), "danger");
  assert.equal(c("gh pr list"), "read");
  assert.equal(c("git rm --cached a"), "write");
  assert.equal(c("git rm a"), "danger");
});

test("catalog prompt text stays compact", () => {
  const t = catalogText();
  assert.ok(t.length < 14000, `catalog text is ${t.length} chars`);
  assert.match(t, /^status\(\) — /m);
  assert.match(t, /branch_create\(name:str, from\?:str, stay\?:bool\)/);
});
