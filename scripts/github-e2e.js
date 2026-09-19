// REAL GitHub end-to-end: real model + real git + real GitHub account.
// Every step is judged by an INDEPENDENT check (gh api / git ls-remote run by
// this script, not by GitCat). If GitCat reports "done" but GitHub disagrees,
// that is recorded as a LIE — the worst possible failure.
//
// Creates 2 private repos named gitcat-e2e-<stamp>-a / -b on the active account.
//   node scripts/github-e2e.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadSettings } from "../src/config/settings.js";
import { detectProviders, modelLabel } from "../src/llm/index.js";
import { createAgent } from "../src/agent/agent.js";

const sh = (bin, args, cwd) => execFileSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryJson = (args) => {
  try {
    return JSON.parse(sh("gh", ["api", ...args]));
  } catch (e) {
    return { __error: String(e.stderr || e.message).split("\n")[0] };
  }
};

const OWNER = sh("gh", ["api", "user", "--jq", ".login"]);
const ORIGINAL_ACCOUNT = OWNER;
const STAMP = new Date().toISOString().replace(/\D/g, "").slice(2, 12);
const A = `gitcat-e2e-${STAMP}-a`;
const B = `gitcat-e2e-${STAMP}-b`;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "gitcat-gh-"));
const WA = path.join(ROOT, A);
const WB = path.join(ROOT, B);
fs.mkdirSync(WA);
fs.mkdirSync(WB);

const settings = { ...loadSettings(), provider: process.argv[2] || loadSettings().provider, mode: "auto" };
await detectProviders(settings);

let items = [];
const ui = {
  status() {},
  emit: (i) => items.push(i),
  confirm: async (r) => (items.push({ type: "confirm", ...r }), true), // approve everything, like a user saying "y"
  interactive: (f) => f(),
};
const agentA = createAgent({ settings, cwd: WA, ui });
const agentB = createAgent({ settings, cwd: WB, ui });

const results = [];
async function step(agent, request, independentCheck, { negative = false } = {}) {
  items = [];
  const t0 = Date.now();
  await agent.handle(request);
  const ms = Date.now() - t0;
  const summary = items.filter((i) => i.type === "summary").at(-1);
  const claimed = summary ? summary.ok : items.some((i) => i.type === "cmd" && !i.ok) ? false : "no-summary";
  // GitHub's REST lists lag a moment behind writes — retry the check before calling it false.
  let truth;
  let why = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await independentCheck(items);
      truth = r === true || r === undefined;
      why = typeof r === "string" ? r : "";
      if (typeof r === "string") truth = false;
    } catch (e) {
      truth = false;
      why = e.message;
    }
    if (truth) break;
    await new Promise((res) => setTimeout(res, 2500));
  }
  const lie = claimed === true && !truth;
  const under = !negative && claimed === false && truth; // negative tests are SUPPOSED to fail
  results.push({ request, truth, claimed, lie, under, why, ms });
  const tag = lie ? "LIE " : truth ? "PASS" : "FAIL";
  console.log(`\n[${tag}] ${request}  (${(ms / 1000).toFixed(1)}s)  gitcat said: ${claimed === true ? "done ✔" : claimed === false ? "NOT done ✖" : claimed === null ? "unverified ⚠" : "(read-only)"}`);
  for (const i of items) {
    if (i.type === "cmd") console.log(`     ${i.ok ? "✔" : "✖"} ${i.command.split("\n")[0].slice(0, 140)}`);
    else if (i.type === "verify") console.log(`       ${i.ok === true ? "verified" : i.ok === false ? "VERIFY FAILED" : "unverified"}: ${i.text}`);
    else if (["diagnosis", "summary", "answer"].includes(i.type)) console.log(`     [${i.type}] ${i.text.split("\n")[0]}`);
    else if (i.type === "agent") console.log(`     [reply] ${i.text}`);
  }
  if (!truth) console.log(`     INDEPENDENT CHECK FAILED: ${why}`);
}
const expect = (cond, msg) => (cond ? true : msg);
const localHead = (cwd, ref = "HEAD") => sh("git", ["rev-parse", ref], cwd);
const remoteSha = (repo, branch) => tryJson([`repos/${OWNER}/${repo}/branches/${branch}`]).commit?.sha;
const write = (dir, f, s) => fs.writeFileSync(path.join(dir, f), s);

console.log(`GitCat REAL GitHub e2e — ${modelLabel(settings)} — account ${OWNER}\nrepos: ${A}, ${B}\nworkdir: ${ROOT}`);

try {
  // ---- repo A: the exact failure from the first real session ----
  write(WA, "README.md", `# ${A}\n\nThrowaway repo created by GitCat's end-to-end test.\n`);
  write(WA, "index.js", "console.log('hello from gitcat e2e')\n");
  sh("git", ["init", "-q", "-b", "main"], WA); // initialized but NO commits — the case that used to produce an empty repo

  await step(agentA, `Create a private github repo named ${A} with a proper description and push this folder to it`, () => {
    const r = tryJson([`repos/${OWNER}/${A}`]);
    if (r.__error) return `repo does not exist on GitHub: ${r.__error}`;
    if (!r.private) return "repo is not private";
    const files = tryJson([`repos/${OWNER}/${A}/contents`]);
    if (files.__error) return `repo is EMPTY on GitHub (${files.__error})`;
    if (!files.some((f) => f.name === "README.md")) return "README.md not on GitHub";
    return expect(remoteSha(A, "main") === localHead(WA), "GitHub main != local HEAD");
  });

  await step(agentA, "did you push it?", (it) => {
    const same = remoteSha(A, "main") === localHead(WA);
    const said = it.find((i) => i.type === "cmd" && /compare/.test(i.command))?.output || "";
    if (same && !/Yes/.test(said)) return `GitHub is in sync but GitCat said: ${said}`;
    if (!same && /Yes/.test(said)) return "GitCat said yes but GitHub is NOT in sync";
    return true;
  });

  write(WA, "index.js", "console.log('hello from gitcat e2e v2')\n");
  await step(agentA, "commit my changes and push", () => {
    const sha = remoteSha(A, "main");
    if (sha !== localHead(WA)) return `GitHub main ${sha?.slice(0, 7)} != local ${localHead(WA).slice(0, 7)}`;
    const msg = tryJson([`repos/${OWNER}/${A}/commits/main`]).commit?.message || "";
    return expect(msg && msg !== "Initial commit", `latest GitHub commit message is "${msg}"`);
  });

  write(WA, "feature.js", "export const feature = true\n");
  await step(agentA, "create a branch called feature/e2e, commit this new file on it and push the branch", () => {
    const sha = remoteSha(A, "feature/e2e");
    if (!sha) return "feature/e2e is not on GitHub";
    return expect(sha === localHead(WA, "feature/e2e"), "GitHub feature/e2e != local");
  });

  await step(agentA, "open a pull request from this branch into main titled 'GitCat e2e PR'", () => {
    const prs = tryJson([`repos/${OWNER}/${A}/pulls?state=open`]);
    if (prs.__error) return prs.__error;
    return expect(prs.some((p) => p.head.ref === "feature/e2e" && p.base.ref === "main"), "no open PR feature/e2e -> main on GitHub");
  });

  await step(agentA, "create a github issue titled 'GitCat e2e issue'", () => {
    const issues = tryJson([`repos/${OWNER}/${A}/issues?state=all`]);
    return expect(Array.isArray(issues) && issues.some((i) => i.title === "GitCat e2e issue" && !i.pull_request), "issue not found on GitHub");
  });
  const issueNo = sh("gh", ["issue", "list", "-R", `${OWNER}/${A}`, "--state", "all", "--search", "GitCat e2e issue", "--json", "number", "--jq", ".[0].number"]);

  await step(agentA, `close issue ${issueNo}`, () => {
    const i = tryJson([`repos/${OWNER}/${A}/issues/${issueNo}`]);
    return expect(i.state === "closed", `issue #${issueNo} is ${i.state || i.__error}`);
  });

  const prNo = (tryJson([`repos/${OWNER}/${A}/pulls?state=all`]).find?.((p) => p.head.ref === "feature/e2e") || {}).number;
  await step(agentA, `merge pull request ${prNo}`, () => {
    const p = tryJson([`repos/${OWNER}/${A}/pulls/${prNo}`]);
    return expect(p.merged === true, `PR #${prNo} merged=${p.merged} state=${p.state || p.__error}`);
  });

  await step(agentA, "switch to main and pull the latest changes", () => {
    if (sh("git", ["branch", "--show-current"], WA) !== "main") return "not on main";
    if (!fs.existsSync(path.join(WA, "feature.js"))) return "merged feature.js not pulled";
    return expect(localHead(WA) === remoteSha(A, "main"), "local main != GitHub main");
  });

  await step(agentA, "tag this as v0.1.0 and push the tag", () => {
    const tags = tryJson([`repos/${OWNER}/${A}/tags`]);
    const t = Array.isArray(tags) && tags.find((x) => x.name === "v0.1.0");
    if (!t) return "tag v0.1.0 not on GitHub";
    return expect(t.commit.sha === localHead(WA), "tag points at a different commit");
  });

  await step(agentA, "publish a github release for v0.1.0", () => {
    const r = tryJson([`repos/${OWNER}/${A}/releases/tags/v0.1.0`]);
    return expect(!r.__error && r.tag_name === "v0.1.0", `no release v0.1.0 on GitHub (${r.__error || ""})`);
  });

  await step(agentA, "delete the feature/e2e branch on github", () => expect(!remoteSha(A, "feature/e2e"), "feature/e2e still exists on GitHub"));

  // teammate pushes first -> our push is rejected -> GitCat must fix and actually land both commits
  const other = path.join(ROOT, "teammate");
  sh("gh", ["repo", "clone", `${OWNER}/${A}`, other, "--", "-q"]);
  write(other, "teammate.txt", "teammate work\n");
  sh("git", ["add", "."], other);
  sh("git", ["-c", "user.name=Teammate", "-c", "user.email=t@example.com", "commit", "-qm", "chore: teammate change"], other);
  sh("git", ["push", "-q"], other);
  write(WA, "mine.txt", "my work\n");
  sh("git", ["add", "."], WA);
  sh("git", ["commit", "-qm", "chore: my change"], WA);
  await step(agentA, "push", () => {
    const sha = remoteSha(A, "main");
    if (sha !== localHead(WA)) return "GitHub main != local after the fix";
    const msgs = (tryJson([`repos/${OWNER}/${A}/commits?per_page=5`]) || []).map?.((c) => c.commit.message) || [];
    return expect(msgs.some((m) => m.includes("teammate")) && msgs.some((m) => m.includes("my change")), `both commits must be on GitHub, got: ${msgs.join(" | ")}`);
  });

  // negative: unpushed commit — GitCat must say NO
  write(WA, "local-only.txt", "not pushed\n");
  sh("git", ["add", "."], WA);
  sh("git", ["commit", "-qm", "chore: local only"], WA);
  await step(agentA, "is it on github?", (it) => {
    const said = it.find((i) => i.type === "cmd" && /compare/.test(i.command))?.output || "";
    if (remoteSha(A, "main") === localHead(WA)) return "setup error: commit got pushed";
    return expect(/NOT pushed|✖/.test(said) && !/✔ Yes/.test(said), `GitCat must say not pushed, said: ${said}`);
  });

  // negative: push to a repo that doesn't exist — must NOT claim done
  const goodUrl = sh("git", ["remote", "get-url", "origin"], WA);
  sh("git", ["remote", "set-url", "origin", `https://github.com/${OWNER}/gitcat-does-not-exist-${STAMP}.git`], WA);
  await step(agentA, "push", (it) => {
    const claimedDone = it.some((i) => i.type === "summary" && i.ok === true);
    return expect(!claimedDone, "GitCat claimed success pushing to a repo that does not exist");
  }, { negative: true });
  sh("git", ["remote", "set-url", "origin", goodUrl], WA);
  await step(agentA, "push", () => expect(remoteSha(A, "main") === localHead(WA), "GitHub main != local"));

  // accounts
  const other2 = sh("gh", ["auth", "status"]).match(/account (\S+)/g)?.map((s) => s.split(" ")[1]).find((a) => a !== OWNER);
  if (other2) {
    await step(agentA, `switch my github account to ${other2}`, () => expect(sh("gh", ["api", "user", "--jq", ".login"]) === other2, "active account did not change"));
    await step(agentA, `switch my github account back to ${OWNER}`, () => expect(sh("gh", ["api", "user", "--jq", ".login"]) === OWNER, "active account not restored"));
  }

  await step(agentA, "list my github repos", (it) => expect(it.some((i) => i.type === "cmd" && i.output.includes(A)), `${A} not in the listing`));

  // ---- repo B: plain folder, not a git repo at all ----
  write(WB, "notes.md", "# notes\n");
  await step(agentB, `put this folder on github as a private repo named ${B}`, () => {
    const r = tryJson([`repos/${OWNER}/${B}`]);
    if (r.__error) return `repo ${B} does not exist: ${r.__error}`;
    if (!r.private) return "not private";
    const files = tryJson([`repos/${OWNER}/${B}/contents`]);
    return expect(Array.isArray(files) && files.some((f) => f.name === "notes.md"), "notes.md not on GitHub (empty repo?)");
  });
} finally {
  try {
    if (sh("gh", ["api", "user", "--jq", ".login"]) !== ORIGINAL_ACCOUNT) sh("gh", ["auth", "switch", "--hostname", "github.com", "--user", ORIGINAL_ACCOUNT]);
  } catch {
    /* reported below */
  }
}

const lies = results.filter((r) => r.lie);
const fails = results.filter((r) => !r.truth);
const under = results.filter((r) => r.under);
console.log("\n================ RESULT ================");
console.log(`${results.length - fails.length}/${results.length} steps actually happened on GitHub (independently checked)`);
console.log(`LIES (said done, wasn't): ${lies.length}${lies.map((l) => `\n  - ${l.request}: ${l.why}`).join("")}`);
console.log(`Under-claims (said not done, was): ${under.length}${under.map((u) => `\n  - ${u.request}`).join("")}`);
console.log(`active gh account now: ${sh("gh", ["api", "user", "--jq", ".login"])}`);
console.log(`test repos left on GitHub: ${OWNER}/${A}, ${OWNER}/${B}`);
process.exit(lies.length || fails.length ? 1 : 0);
