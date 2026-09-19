import fs from "node:fs";
import path from "node:path";
import { q } from "../exec/run.js";

// GitHub accounts come from gh's own hosts.yml — instant and offline, unlike
// `gh auth status` (~1s, hits the network). Re-read on demand after a switch.
let ghCache = null;

function ghHostsFile() {
  if (process.env.GH_CONFIG_DIR) return path.join(process.env.GH_CONFIG_DIR, "hosts.yml");
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "GitHub CLI", "hosts.yml");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config"), "gh", "hosts.yml");
}

/** Minimal parse of the github.com block: `users:` children and `user:` (active). */
export function parseGhHosts(text) {
  const accounts = [];
  let active = "";
  let inGithub = false;
  let inUsers = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inGithub = line.startsWith("github.com:");
      inUsers = false;
      continue;
    }
    if (!inGithub) continue;
    const indent = line.match(/^ */)[0].length;
    const m = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    if (indent <= 4 && m[1] === "users") inUsers = true;
    else if (indent <= 4) {
      inUsers = false;
      if (m[1] === "user") active = m[2].trim();
    } else if (inUsers && indent <= 8 && m[1] !== "oauth_token" && m[1] !== "git_protocol") accounts.push(m[1]);
  }
  if (active && !accounts.includes(active)) accounts.unshift(active);
  return { ghUser: active || accounts[0] || "", ghAccounts: accounts };
}

export function loadGhAccounts() {
  if (!ghCache) {
    try {
      ghCache = parseGhHosts(fs.readFileSync(ghHostsFile(), "utf8"));
    } catch {
      ghCache = { ghUser: "", ghAccounts: [] };
    }
  }
  return ghCache;
}
export function resetGhCache() {
  ghCache = null;
}

/** Parse `git status --porcelain=v2 --branch` into a small object. */
export function parseStatus(text) {
  const s = { branch: "", oid: "", upstream: "", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicts: [] };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("# branch.head ")) s.branch = line.slice(14);
    else if (line.startsWith("# branch.oid ")) s.oid = line.slice(13);
    else if (line.startsWith("# branch.upstream ")) s.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) [s.ahead, s.behind] = [+m[1], +m[2]];
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1];
      const file = line.startsWith("2 ") ? line.split("\t")[0].split(" ").slice(9).join(" ") : parts.slice(8).join(" ");
      if (xy[0] !== ".") s.staged.push(`${xy[0]} ${file}`);
      if (xy[1] !== ".") s.unstaged.push(`${xy[1]} ${file}`);
    } else if (line.startsWith("u ")) s.conflicts.push(line.split(" ").slice(10).join(" "));
    else if (line.startsWith("? ")) s.untracked.push(line.slice(2));
  }
  if (s.branch === "(detached)") s.branch = "";
  return s;
}

function inProgressState(gitDir) {
  if (!gitDir) return "";
  const has = (f) => fs.existsSync(path.join(gitDir, f));
  if (has("rebase-merge") || has("rebase-apply")) return "rebase";
  if (has("MERGE_HEAD")) return "merge";
  if (has("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (has("REVERT_HEAD")) return "revert";
  if (has("BISECT_LOG")) return "bisect";
  return "";
}

/** Everything the planner needs to fill in names correctly. ~5 parallel git calls, ~60-150ms. */
export async function snapshot(cwd) {
  const inside = await q(["git", "rev-parse", "--show-toplevel", "--absolute-git-dir"], cwd);
  const gh = loadGhAccounts();
  if (!inside) {
    return { isRepo: false, cwd, root: "", branch: "", remotes: [], remoteUrls: {}, branches: [], hasCommits: false, ...gh };
  }
  const [root, gitDir] = inside.split(/\r?\n/);
  const [statusText, branchesText, remotesText, stashText, logText, tagsText] = await Promise.all([
    q(["git", "status", "--porcelain=v2", "--branch"], cwd),
    q(["git", "for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", "refs/heads", "refs/remotes"], cwd),
    q(["git", "remote", "-v"], cwd),
    q(["git", "stash", "list", "--format=%gd %s"], cwd),
    q(["git", "log", "-5", "--format=%h %s"], cwd),
    q(["git", "tag", "--sort=-creatordate"], cwd),
  ]);
  const st = parseStatus(statusText);
  const remoteUrls = {};
  for (const l of remotesText.split(/\r?\n/)) {
    const m = l.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
    if (m) remoteUrls[m[1]] = m[2];
  }
  const remotes = Object.keys(remoteUrls);
  const refs = branchesText ? branchesText.split(/\r?\n/) : [];
  const remotePrefixes = remotes.map((r) => r + "/");
  const branches = refs.filter((b) => !remotePrefixes.some((p) => b.startsWith(p)));
  const remoteBranches = refs.filter((b) => remotePrefixes.some((p) => b.startsWith(p)) && !b.endsWith("/HEAD"));
  const upstreamRemote = st.upstream ? st.upstream.split("/")[0] : "";
  return {
    isRepo: true,
    cwd,
    root,
    gitDir,
    ...st,
    hasCommits: st.oid && st.oid !== "(initial)",
    inProgress: inProgressState(gitDir),
    branches,
    remoteBranches,
    remotes,
    remoteUrls,
    upstreamRemote,
    defaultRemote: remotes.includes("origin") ? "origin" : remotes[0] || "",
    stashes: stashText ? stashText.split(/\r?\n/) : [],
    recent: logText ? logText.split(/\r?\n/) : [],
    tags: tagsText ? tagsText.split(/\r?\n/).slice(0, 5) : [],
    ...gh,
  };
}

const cap = (arr, n) => (arr.length > n ? [...arr.slice(0, n), `…+${arr.length - n} more`] : arr);

/** Compact text for the prompt (~100-250 tokens). */
export function contextText(s) {
  if (!s.isRepo) {
    return [`folder: ${s.cwd}`, `NOT a git repository (use init or clone first)`, s.ghUser ? `github: active=${s.ghUser} all=[${s.ghAccounts.join(", ")}]` : "github: not logged in"].join("\n");
  }
  const lines = [`repo: ${s.root}`];
  let b = `branch: ${s.branch || "(detached HEAD)"}`;
  if (!s.hasCommits) b += " (no commits yet)";
  if (s.upstream) b += ` -> ${s.upstream} ahead ${s.ahead} behind ${s.behind}`;
  else if (s.branch) b += s.remotes.length ? " (NOT pushed yet: no upstream — needs push)" : " (no upstream, never pushed)";
  lines.push(b);
  if (s.inProgress) lines.push(`IN PROGRESS: ${s.inProgress}${s.conflicts.length ? ` conflicts: ${s.conflicts.join(", ")}` : ""}`);
  if (s.staged.length) lines.push(`staged: ${cap(s.staged, 12).join("; ")}`);
  if (s.unstaged.length) lines.push(`modified: ${cap(s.unstaged, 12).join("; ")}`);
  if (s.untracked.length) lines.push(`untracked: ${cap(s.untracked, 12).join("; ")}`);
  if (!s.staged.length && !s.unstaged.length && !s.untracked.length && !s.conflicts.length) lines.push("working tree clean");
  lines.push(`local branches: ${cap(s.branches, 15).join(", ") || "none"}`);
  if (s.remoteBranches.length) lines.push(`remote branches: ${cap(s.remoteBranches, 10).join(", ")}`);
  lines.push(`remotes: ${s.remotes.map((r) => `${r}=${s.remoteUrls[r]}`).join(", ") || "none"}`);
  if (s.stashes.length) lines.push(`stashes: ${cap(s.stashes, 4).join(" | ")}`);
  if (s.tags.length) lines.push(`tags: ${s.tags.join(", ")}`);
  if (s.recent.length) lines.push(`recent commits: ${s.recent.join(" | ")}`);
  lines.push(s.ghUser ? `github: active=${s.ghUser} all=[${s.ghAccounts.join(", ")}]` : "github: not logged in");
  return lines.join("\n");
}
