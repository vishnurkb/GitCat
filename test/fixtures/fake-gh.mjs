// Stand-in for the GitHub CLI in tests (enabled via GITCAT_GH_SHIM).
// `repo create NAME ... --source=. --remote=R [--push]` behaves like the real
// thing, with a local bare repo in FAKE_GH_DIR playing GitHub.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dir = process.env.FAKE_GH_DIR;
const git = (...a) => execFileSync("git", a, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

if (args[0] === "repo" && args[1] === "create") {
  const name = args[2];
  const bare = path.join(dir, `${name}.git`);
  if (fs.existsSync(bare)) {
    console.error(`GraphQL: Name already exists on this account (createRepository)`);
    process.exit(1);
  }
  git("init", "-q", "--bare", "-b", "main", bare);
  const remote = (args.find((a) => a.startsWith("--remote=")) || "--remote=origin").split("=")[1];
  if (args.some((a) => a.startsWith("--source"))) {
    git("remote", "add", remote, bare);
    console.log(`✓ Added remote ${bare}`);
    if (args.includes("--push")) {
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
  console.log(`name:\tfake/${name}\n${log ? `commits:\n${log}` : "This repository is empty."}`);
  process.exit(0);
}
console.error(`fake gh: unsupported command: ${args.join(" ")}`);
process.exit(1);
