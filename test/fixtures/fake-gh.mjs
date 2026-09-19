// Stand-in for the GitHub CLI in tests (enabled via GITCAT_GH_SHIM).
// A local bare repo in FAKE_GH_DIR plays GitHub.
//   repo create NAME [--private|--public] --source=. --remote=R [--push]
//   repo view NAME [--json fields]
// FAKE_GH_LIE=1 makes `repo create` exit 0 WITHOUT pushing — the exact failure
// the verifier must catch (a command that "succeeds" but didn't do the work).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dir = process.env.FAKE_GH_DIR;
const git = (...a) => execFileSync("git", a, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
const meta = (name) => path.join(dir, `${name}.meta.json`);

if (args[0] === "repo" && args[1] === "create") {
  const name = args[2];
  const bare = path.join(dir, `${name}.git`);
  if (fs.existsSync(bare)) {
    console.error(`GraphQL: Name already exists on this account (createRepository)`);
    process.exit(1);
  }
  git("init", "-q", "--bare", "-b", "main", bare);
  const visibility = args.includes("--public") ? "PUBLIC" : args.includes("--internal") ? "INTERNAL" : "PRIVATE";
  fs.writeFileSync(meta(name), JSON.stringify({ visibility }));
  const remote = (args.find((a) => a.startsWith("--remote=")) || "--remote=origin").split("=")[1];
  if (args.some((a) => a.startsWith("--source"))) {
    git("remote", "add", remote, bare);
    console.log(`✓ Added remote ${bare}`);
    if (args.includes("--push") && !process.env.FAKE_GH_LIE) {
      try {
        git("push", "-u", remote, "HEAD");
      } catch (e) {
        console.error(String(e.stderr || e.message));
        process.exit(1);
      }
      console.log(`✓ Pushed commits to ${bare}`);
    }
  }
  console.log(`https://github.com/fake/${name}`);
  process.exit(0);
}

if (args[0] === "repo" && args[1] === "view") {
  const name = (args[2] && !args[2].startsWith("-") ? args[2] : "").split("/").pop();
  const bare = path.join(dir, `${name}.git`);
  if (!name || !fs.existsSync(bare)) {
    console.error("GraphQL: Could not resolve to a Repository");
    process.exit(1);
  }
  let log = "";
  try {
    log = git("--git-dir", bare, "log", "--oneline", "main").trim();
  } catch {
    /* empty repo */
  }
  if (args.includes("--json")) {
    const { visibility } = JSON.parse(fs.readFileSync(meta(name), "utf8"));
    console.log(JSON.stringify({ url: `https://github.com/fake/${name}`, visibility, isEmpty: !log, defaultBranchRef: { name: log ? "main" : "" } }));
  } else {
    console.log(`name:\tfake/${name}\n${log ? `commits:\n${log}` : "This repository is empty."}`);
  }
  process.exit(0);
}
console.error(`fake gh: unsupported command: ${args.join(" ")}`);
process.exit(1);
