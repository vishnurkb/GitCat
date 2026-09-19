// TUI behavior through ink-testing-library: typing, slash menu, confirm dialog,
// mode cycling, history. Real git underneath, scripted model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gitcat-home-"));
process.env.GITCAT_HOME = HOME; // keep tests out of the real ~/.gitcat
const { render } = await import("ink-testing-library");
const { html } = await import("../src/ui/theme.js");
const { App } = await import("../src/ui/App.js");
const { snapshot } = await import("../src/agent/context.js");

const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "gitcat-ui-"));
const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const ENTER = "\r";
const SHIFT_TAB = "\x1b[Z";
const UP = "\x1b[A";

/** Poll until fn() is truthy — test files run in parallel, so fixed sleeps are flaky. */
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await wait(25);
  }
}

before(() => {
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(REPO, "a.txt"), "x\n");
  git("add", ".");
  git("commit", "-qm", "init");
});
after(() => {
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

function fakeLlm(plans) {
  return async (s, messages, opts) => {
    if (!opts.json) return { text: "feat: ui test", provider: "fake", model: "fake", ms: 1 };
    const next = plans.shift() || { steps: [] };
    return { text: JSON.stringify({ reply: next.reply || "On it.", ask: "", explain: false, ...next }), provider: "fake", model: "fake", ms: 1 };
  };
}

async function mount(plans = [], mode = "auto") {
  const settings = { provider: "ollama", ollamaModel: "fake", groqModel: "fake", ollamaUrl: "http://127.0.0.1:1", mode };
  const r = render(html`<${App} settings=${settings} cwd=${REPO} initialRepo=${await snapshot(REPO)} llm=${fakeLlm(plans)} />`);
  await wait(80);
  const type = async (s) => {
    for (const ch of s) {
      r.stdin.write(ch);
      await wait(2);
    }
  };
  const all = () => strip(r.frames.join("\n"));
  return { r, type, frame: () => strip(r.lastFrame()), all, settings };
}

test("header, tips, input and status line render", async () => {
  const { r, frame } = await mount();
  const f = frame();
  assert.match(f, /GitCat/);
  assert.match(f, /\( o\.o \)/); // the cat
  assert.match(f, /⎇ main/);
  assert.match(f, /auto — asks only before dangerous commands/);
  r.unmount();
});

test("typing / opens the slash menu, filtering narrows it, tab completes", async () => {
  const { r, type, frame } = await mount();
  await type("/");
  await until(() => /\/help/.test(frame()));
  assert.match(frame(), /\/status/);
  await type("pu");
  await until(() => /❯ \/push/.test(frame()));
  assert.doesNotMatch(frame(), /\/help/);
  r.stdin.write("\t");
  await until(() => /❯ \/push\s/.test(frame()));
  assert.match(frame(), /❯ \/push\s/);
  r.unmount();
});

test("slash command runs through the fast path (no model) and shows output", async () => {
  const { r, type, all } = await mount();
  await type("/status");
  r.stdin.write(ENTER);
  await until(() => /✔ git status -sb/.test(all()));
  assert.match(all(), /✔ git status -sb/);
  r.unmount();
});

test("plain-English request: agent reply, command result, repo updated", async () => {
  const { r, type, all } = await mount([{ reply: "Creating the branch.", steps: [{ op: "branch_create", args: { name: "ui-branch" } }] }]);
  await type("make a branch called ui-branch");
  r.stdin.write(ENTER);
  await until(() => /✔ git switch -c ui-branch/.test(all()));
  assert.match(all(), /❯ make a branch called ui-branch/);
  assert.match(all(), /● Creating the branch\./);
  assert.match(all(), /✔ git switch -c ui-branch/);
  assert.equal(git("branch", "--show-current"), "ui-branch");
  git("switch", "-q", "main");
  r.unmount();
});

test("dangerous plan shows a confirm box; 'n' skips it", async () => {
  fs.writeFileSync(path.join(REPO, "a.txt"), "edited\n");
  const { r, type, frame, all } = await mount([{ steps: [{ op: "discard", args: {} }] }]);
  await type("throw away my changes");
  r.stdin.write(ENTER);
  await until(() => /Run these commands/.test(frame()));
  assert.match(frame(), /Run these commands\?\s+\(destructive\)/);
  assert.match(frame(), /\$ git restore -- \./);
  r.stdin.write("n");
  await until(() => /Skipped — nothing was run/.test(all()));
  assert.match(all(), /Skipped — nothing was run/);
  assert.equal(fs.readFileSync(path.join(REPO, "a.txt"), "utf8"), "edited\n");
  r.unmount();
});

test("confirm 'y' runs the dangerous command", async () => {
  const { r, type, frame, all } = await mount([{ steps: [{ op: "discard", args: {} }] }]);
  await type("throw away my changes");
  r.stdin.write(ENTER);
  await until(() => /Run these commands/.test(frame()));
  r.stdin.write("y");
  await until(() => /✔ git restore -- \./.test(all()));
  assert.match(all(), /✔ git restore -- \./);
  assert.equal(fs.readFileSync(path.join(REPO, "a.txt"), "utf8"), "x\n");
  r.unmount();
});

test("shift+tab cycles auto -> confirm -> yolo", async () => {
  const { r, frame, settings } = await mount();
  r.stdin.write(SHIFT_TAB);
  await until(() => /confirm — asks before every change/.test(frame()));
  assert.match(frame(), /confirm — asks before every change/);
  r.stdin.write(SHIFT_TAB);
  await until(() => /yolo — never asks/.test(frame()));
  assert.match(frame(), /yolo — never asks/);
  assert.equal(settings.mode, "yolo");
  r.unmount();
});

test("up arrow recalls previous input", async () => {
  const { r, type, frame, all } = await mount();
  await type("/status");
  r.stdin.write(ENTER);
  await until(() => /✔ git status -sb/.test(all()));
  await wait(50);
  r.stdin.write(UP);
  await until(() => /❯ \/status/.test(frame()));
  assert.match(frame(), /❯ \/status/);
  r.unmount();
});

test("/help lists examples and every slash command", async () => {
  const { r, type, all } = await mount();
  await type("/help");
  r.stdin.write(ENTER);
  await until(() => /Just say what you want/.test(all()));
  assert.match(all(), /\/model/);
  assert.match(all(), /\/mode/);
  r.unmount();
});
