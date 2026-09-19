// Post-condition checks. A command exiting 0 is not proof the user's intent
// happened (gh repo create without --push exits 0 and leaves an EMPTY repo).
// After each state-changing step we look at the real state — local refs,
// the remote via ls-remote, GitHub via gh — and only then call it done.
//
// Each verifier returns {ok: true|false|null, text}. null = could not check
// (network, etc.). null is NEVER reported as success.
import fs from "node:fs";
import path from "node:path";
import { run } from "../exec/run.js";
import { snapshot, resetGhCache, loadGhAccounts } from "./context.js";

const quiet = async (argv, cwd) => {
  const r = await run(argv, { cwd, color: false, timeoutMs: 30_000 });
  return { ok: r.ok, out: r.stdout.trim(), err: r.stderr.trim() };
};
const short = (sha) => (sha || "").slice(0, 7);
const pass = (text) => ({ ok: true, text });
const fail = (text) => ({ ok: false, text });
const unknown = (text) => ({ ok: null, text });

async function headSha(cwd) {
  // --verify --quiet + exit code: in a repo with no commits, plain `rev-parse HEAD`
  // prints the literal text "HEAD", which once passed for a commit hash.
  const r = await quiet(["git", "rev-parse", "--verify", "--quiet", "HEAD"], cwd);
  return r.ok && /^[0-9a-f]{40,64}$/.test(r.out) ? r.out : "";
}

/** Ask the remote itself (not the local tracking ref) where a branch points. */
async function remoteBranchSha(cwd, remote, branch) {
  const r = await quiet(["git", "ls-remote", remote, `refs/heads/${branch}`], cwd);
  if (!r.ok) return { error: r.err || "ls-remote failed" };
  return { sha: r.out.split(/\s+/)[0] || "" };
}

async function verifyPushed(cwd, remoteHint, branchHint) {
  const s = await snapshot(cwd);
  const branch = branchHint || s.branch;
  const remote = remoteHint || s.upstreamRemote || s.defaultRemote || "origin";
  const local = await quiet(["git", "rev-parse", `refs/heads/${branch}`], cwd);
  const r = await remoteBranchSha(cwd, remote, branch);
  if (r.error) return unknown(`could not reach ${remote} to confirm the push (${r.error.split("\n")[0]})`);
  if (!r.sha) return fail(`${branch} is NOT on ${remote} — the remote has no such branch`);
  if (r.sha !== local.out) return fail(`${remote}/${branch} is at ${short(r.sha)} but local ${branch} is ${short(local.out)} — not fully pushed`);
  return pass(`${remote}/${branch} is at ${short(r.sha)}, same as local — confirmed on the remote`);
}

const ghJson = async (args, cwd) => {
  const r = await quiet(["gh", ...args], cwd);
  if (!r.ok) return { error: r.err || r.out };
  try {
    return { data: JSON.parse(r.out) };
  } catch {
    return { error: `unexpected gh output: ${r.out.slice(0, 120)}` };
  }
};

/** Pull a GitHub URL / #number out of command output, e.g. from `gh pr create`. */
const urlIn = (text) => (String(text).match(/https:\/\/github\.com\/[^\s]+/) || [])[0] || "";

const VERIFIERS = {
  async commit(args, before, cwd) {
    const now = await headSha(cwd);
    if (!now || now === before.headSha) return fail("no new commit was created");
    const msg = (await quiet(["git", "log", "-1", "--format=%s"], cwd)).out;
    return pass(`commit ${short(now)} created: "${msg}"`);
  },
  async squash_last(args, before, cwd) {
    return VERIFIERS.commit(args, before, cwd);
  },
  async push(args, before, cwd) {
    return verifyPushed(cwd, args.remote, args.branch);
  },
  async sync(args, before, cwd) {
    return verifyPushed(cwd);
  },
  async pull(args, before, cwd) {
    // Ask the remote itself: the local tracking ref is stale if the fetch failed.
    const s = await snapshot(cwd);
    const remote = args.remote || s.upstreamRemote || s.defaultRemote;
    const branch = args.branch || (s.upstream ? s.upstream.slice(remote.length + 1) : s.branch);
    if (!remote) return unknown("no remote to compare with");
    const r = await remoteBranchSha(cwd, remote, branch);
    if (r.error) return unknown(`could not reach ${remote} to confirm (${r.error.split("\n")[0]})`);
    if (!r.sha) return fail(`${remote} has no branch ${branch}`);
    const contained = (await quiet(["git", "merge-base", "--is-ancestor", r.sha, "HEAD"], cwd)).ok;
    return contained ? pass(`local ${s.branch} includes ${remote}/${branch} (${short(r.sha)}) — up to date`) : fail(`local ${s.branch} does NOT include ${remote}/${branch} (${short(r.sha)})`);
  },
  async branch_create(args, before, cwd) {
    const exists = (await quiet(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${args.name}`], cwd)).ok;
    if (!exists) return fail(`branch ${args.name} does not exist`);
    if (!args.stay && (await snapshot(cwd)).branch !== args.name) return fail(`branch ${args.name} exists but you are not on it`);
    return pass(`branch ${args.name} exists${args.stay ? "" : " and is checked out"}`);
  },
  async switch(args, before, cwd) {
    const cur = (await snapshot(cwd)).branch;
    // "origin/dev" checks out a local "dev"
    const local = (before.remotes || []).reduce((b, r) => (b.startsWith(`${r}/`) ? b.slice(r.length + 1) : b), args.branch);
    return cur === args.branch || cur === local ? pass(`on branch ${cur}`) : fail(`expected to be on ${args.branch}, but on ${cur || "detached HEAD"}`);
  },
  async merge(args, before, cwd) {
    if (args.squash) return pass("squash staged (commit it to finish)");
    const r = await quiet(["git", "merge-base", "--is-ancestor", args.branch, "HEAD"], cwd);
    return r.ok ? pass(`${args.branch} is now part of ${(await snapshot(cwd)).branch}`) : fail(`${args.branch} is NOT merged into the current branch`);
  },
  async branch_delete(args, before, cwd) {
    const exists = (await quiet(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${args.name}`], cwd)).ok;
    return exists ? fail(`branch ${args.name} still exists`) : pass(`branch ${args.name} deleted`);
  },
  async tag_create(args, before, cwd) {
    return (await quiet(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${args.name}`], cwd)).ok ? pass(`tag ${args.name} exists`) : fail(`tag ${args.name} was not created`);
  },
  async push_tags(args, before, cwd) {
    const remote = args.remote || "origin";
    const r = await quiet(["git", "ls-remote", "--tags", remote], cwd);
    if (!r.ok) return unknown(`could not reach ${remote} to confirm tags`);
    const want = args.name ? [args.name] : (await quiet(["git", "tag"], cwd)).out.split(/\r?\n/).filter(Boolean);
    const missing = want.filter((t) => !r.out.includes(`refs/tags/${t}`));
    return missing.length ? fail(`tag(s) not on ${remote}: ${missing.join(", ")}`) : pass(`tag(s) on ${remote}: ${want.join(", ")}`);
  },
  async delete_remote_branch(args, before, cwd) {
    const r = await remoteBranchSha(cwd, args.remote || "origin", args.branch);
    if (r.error) return unknown(`could not reach the remote to confirm`);
    return r.sha ? fail(`${args.branch} still exists on the remote`) : pass(`${args.branch} no longer exists on the remote`);
  },
  async remote_add(args, before, cwd) {
    const url = (await quiet(["git", "remote", "get-url", args.name || "origin"], cwd)).out;
    return url === args.url ? pass(`remote ${args.name || "origin"} → ${url}`) : fail(`remote ${args.name || "origin"} is "${url}", expected "${args.url}"`);
  },
  async remote_set_url(args, before, cwd) {
    return VERIFIERS.remote_add(args, before, cwd);
  },
  async init(args, before, cwd) {
    return fs.existsSync(path.join(cwd, ".git")) ? pass("git repository initialized") : fail("no .git folder was created");
  },
  async untrack(args, before, cwd) {
    const still = (await quiet(["git", "ls-files", "--", ...args.paths], cwd)).out;
    return still ? fail(`still tracked: ${still.split("\n").slice(0, 3).join(", ")}`) : pass(`no longer tracked: ${args.paths.join(", ")}`);
  },
  async stash(args, before, cwd) {
    const n = (await snapshot(cwd)).stashes.length;
    return n > (before.stashes?.length || 0) ? pass("changes stashed") : fail("nothing was stashed");
  },
  async stash_pop(args, before, cwd) {
    const n = (await snapshot(cwd)).stashes.length;
    return n < (before.stashes?.length || 0) ? pass("stash re-applied and removed") : fail("stash is still there");
  },
  async undo_commit(args, before, cwd) {
    const now = await headSha(cwd);
    if (now === before.headSha) return fail("HEAD did not move — the commit is still there");
    const staged = (await quiet(["git", "diff", "--cached", "--name-only"], cwd)).out;
    const dirty = (await quiet(["git", "status", "--porcelain", "--untracked-files=no"], cwd)).out;
    const where = now ? `HEAD moved back to ${short(now)}` : "the only commit was undone";
    if (args.discard) return dirty ? fail(`${where}, but changes are still there: ${dirty.split("\n").slice(0, 3).join(", ")}`) : pass(`${where}; its changes were discarded`);
    if (args.unstage) return staged ? fail(`${where}, but files are still staged`) : pass(`${where}; changes kept as unstaged edits`);
    return pass(`${where}; your changes are kept (staged)`);
  },
  async gh_switch_account(args, before, cwd, ctx) {
    resetGhCache();
    const active = loadGhAccounts().ghUser;
    const want = args.user || (before.ghAccounts || []).find((a) => a !== before.ghUser);
    return active === want ? pass(`active GitHub account is now ${active}`) : fail(`active GitHub account is ${active}, not ${want}`);
  },
  async gh_repo_create(args, before, cwd, ctx) {
    const name = ctx.builtName;
    const r = await ghJson(["repo", "view", name, "--json", "url,visibility,isEmpty,defaultBranchRef"], cwd);
    if (r.error) return fail(`GitHub has no repo ${name}: ${r.error.split("\n")[0]}`);
    const d = r.data;
    const want = (args.visibility || "private").toUpperCase();
    if (d.visibility && d.visibility !== want) return fail(`${d.url} exists but is ${d.visibility}, expected ${want}`);
    if (ctx.pushed) {
      if (d.isEmpty) return fail(`${d.url} was created but is EMPTY — nothing was pushed`);
      const pushed = await verifyPushed(cwd);
      if (pushed.ok !== true) return pushed;
      return pass(`${d.url} exists (${d.visibility?.toLowerCase()}) and has your code — ${pushed.text}`);
    }
    return pass(`${d.url} exists (${d.visibility?.toLowerCase()}), empty as requested`);
  },
  async gh_pr_create(args, before, cwd, ctx) {
    const url = urlIn(ctx.output);
    const r = await ghJson(["pr", "view", ...(url ? [url] : []), "--json", "url,state,headRefName,baseRefName"], cwd);
    if (r.error) return fail(`no pull request found on GitHub: ${r.error.split("\n")[0]}`);
    return r.data.state === "OPEN" ? pass(`PR ${r.data.url} is open (${r.data.headRefName} → ${r.data.baseRefName})`) : fail(`PR ${r.data.url} is ${r.data.state}, not open`);
  },
  async gh_pr_merge(args, before, cwd) {
    const r = await ghJson(["pr", "view", ...(args.number ? [args.number] : []), "--json", "url,state"], cwd);
    if (r.error) return unknown(`could not read the PR back: ${r.error.split("\n")[0]}`);
    return r.data.state === "MERGED" ? pass(`PR ${r.data.url} is merged on GitHub`) : fail(`PR ${r.data.url} is ${r.data.state}, NOT merged`);
  },
  async gh_pr_close(args, before, cwd) {
    const r = await ghJson(["pr", "view", args.number, "--json", "url,state"], cwd);
    if (r.error) return unknown("could not read the PR back");
    return r.data.state === "CLOSED" ? pass(`PR ${r.data.url} is closed`) : fail(`PR is ${r.data.state}`);
  },
  async gh_issue_create(args, before, cwd, ctx) {
    const url = urlIn(ctx.output);
    if (!url) return fail("gh did not return an issue URL");
    const r = await ghJson(["issue", "view", url, "--json", "url,state,title"], cwd);
    if (r.error) return fail(`issue not found on GitHub: ${r.error.split("\n")[0]}`);
    return pass(`issue ${r.data.url} is ${r.data.state.toLowerCase()}: "${r.data.title}"`);
  },
  async gh_issue_close(args, before, cwd) {
    const r = await ghJson(["issue", "view", args.number, "--json", "url,state"], cwd);
    if (r.error) return unknown("could not read the issue back");
    return r.data.state === "CLOSED" ? pass(`issue ${r.data.url} is closed`) : fail(`issue ${r.data.url} is still ${r.data.state}`);
  },
  async gh_release_create(args, before, cwd) {
    const r = await ghJson(["release", "view", args.tag, "--json", "url,tagName,isDraft"], cwd);
    if (r.error) return fail(`no release ${args.tag} on GitHub: ${r.error.split("\n")[0]}`);
    return pass(`release ${r.data.url} is published`);
  },
  async gh_repo_visibility(args, before, cwd) {
    const r = await ghJson(["repo", "view", ...(args.repo ? [args.repo] : []), "--json", "url,visibility"], cwd);
    if (r.error) return unknown("could not read the repo back");
    return r.data.visibility === args.visibility.toUpperCase() ? pass(`${r.data.url} is now ${args.visibility}`) : fail(`${r.data.url} is still ${r.data.visibility}`);
  },
};

// ---- more post-conditions: history edits, cleanup, config, cloning ----------

const newCommit = async (before, cwd, what) => {
  const now = await headSha(cwd);
  if (!now || now === before.headSha) return fail(`no new commit — ${what} did not happen`);
  return pass(`${what}: new commit ${short(now)} "${(await quiet(["git", "log", "-1", "--format=%s"], cwd)).out}"`);
};
const notInProgress = async (cwd, what) => {
  const s = await snapshot(cwd);
  if (s.inProgress) return fail(`a ${s.inProgress} is still in progress${s.conflicts.length ? ` (conflicts: ${s.conflicts.join(", ")})` : ""}`);
  return pass(what);
};
const cfg = async (cwd, key, global) => (await quiet(["git", "config", ...(global ? ["--global"] : []), "--get", key], cwd)).out;

Object.assign(VERIFIERS, {
  revert: (args, before, cwd) => newCommit(before, cwd, `reverted ${args.ref}`),
  cherry_pick: (args, before, cwd) => newCommit(before, cwd, `cherry-picked ${args.refs.join(", ")}`),
  rebase: (args, before, cwd) => notInProgress(cwd, `rebased onto ${args.onto}`),
  continue: (args, before, cwd) => notInProgress(cwd, "finished — nothing left in progress"),
  abort: (args, before, cwd) => notInProgress(cwd, "aborted — nothing left in progress"),
  resolve_conflicts: (args, before, cwd) => notInProgress(cwd, `conflicts resolved (kept ${args.side}) and concluded`),
  async reset(args, before, cwd) {
    // resolve the target against the state BEFORE the reset (HEAD~1 means something else afterwards)
    const ref = (args.ref || "HEAD").replace(/^HEAD/, before.headSha || "HEAD");
    const target = (await quiet(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd)).out;
    const now = await headSha(cwd);
    return target && now === target ? pass(`branch now at ${short(now)} (${args.ref || "HEAD"}, ${args.mode || "mixed"})`) : fail(`HEAD is ${short(now)}, expected ${args.ref || "HEAD"} (${short(target)})`);
  },
  async discard(args, before, cwd) {
    // both unstaged AND staged edits must be gone
    const dirty = (await quiet(["git", "diff", "HEAD", "--name-only", "--", ...(args.paths || ["."])], cwd)).out;
    return dirty ? fail(`still modified: ${dirty.split("\n").slice(0, 5).join(", ")}`) : pass(`uncommitted edits discarded${args.paths ? `: ${args.paths.join(", ")}` : ""} — files match the last commit`);
  },
  async restore_file(args, before, cwd) {
    const d = (await quiet(["git", "diff", "--name-only", args.ref || "HEAD", "--", args.path], cwd)).out;
    return d ? fail(`${args.path} still differs from ${args.ref || "HEAD"}`) : pass(`${args.path} matches ${args.ref || "HEAD"}`);
  },
  async clean(args, before, cwd) {
    if (args.dry) return pass("listed only (dry run)");
    // without dirs=true git keeps untracked FOLDERS; only loose files must be gone
    const left = (await quiet(["git", "ls-files", "--others", "--directory", ...(args.ignored ? [] : ["--exclude-standard"])], cwd)).out.split(/\r?\n/).filter(Boolean);
    const shouldBeGone = args.dirs ? left : left.filter((f) => !f.endsWith("/"));
    if (shouldBeGone.length) return fail(`still untracked: ${shouldBeGone.slice(0, 5).join(", ")}`);
    return pass(left.length ? `untracked files removed (untracked folders kept: ${left.slice(0, 3).join(", ")})` : "no untracked files left");
  },
  async remote_remove(args, before, cwd) {
    return (await quiet(["git", "remote", "get-url", args.name], cwd)).ok ? fail(`remote ${args.name} still exists`) : pass(`remote ${args.name} removed`);
  },
  async remote_rename(args, before, cwd) {
    return (await quiet(["git", "remote", "get-url", args.to], cwd)).ok ? pass(`remote renamed ${args.from} → ${args.to}`) : fail(`no remote named ${args.to}`);
  },
  async branch_rename(args, before, cwd) {
    const has = async (b) => (await quiet(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${b}`], cwd)).ok;
    if (!(await has(args.to))) return fail(`no branch named ${args.to}`);
    if (args.from && (await has(args.from))) return fail(`old branch ${args.from} still exists`);
    return pass(`branch is now called ${args.to}`);
  },
  async tag_delete(args, before, cwd) {
    return (await quiet(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${args.name}`], cwd)).ok ? fail(`tag ${args.name} still exists`) : pass(`tag ${args.name} deleted locally`);
  },
  async stash_drop(args, before, cwd) {
    const n = (await snapshot(cwd)).stashes.length;
    return n < (before.stashes?.length || 0) || (args.all && n === 0) ? pass(args.all ? "all stashes cleared" : "stash dropped") : fail("stash is still there");
  },
  async set_identity(args, before, cwd) {
    const bad = [];
    if (args.name && (await cfg(cwd, "user.name", args.global)) !== args.name) bad.push("name");
    if (args.email && (await cfg(cwd, "user.email", args.global)) !== args.email) bad.push("email");
    return bad.length ? fail(`git ${bad.join(" and ")} not set`) : pass(`git identity: ${[args.name, args.email].filter(Boolean).join(" <") + (args.email && args.name ? ">" : "")}`);
  },
  async config_set(args, before, cwd) {
    return (await cfg(cwd, args.key, args.global)) === args.value ? pass(`${args.key} = ${args.value}`) : fail(`${args.key} is not ${args.value}`);
  },
  async gitignore_add(args, before, cwd) {
    const root = before.root || cwd;
    const text = fs.existsSync(path.join(root, ".gitignore")) ? fs.readFileSync(path.join(root, ".gitignore"), "utf8") : "";
    const lines = new Set(text.split(/\r?\n/).map((l) => l.trim()));
    const missing = args.patterns.filter((p) => !lines.has(p));
    return missing.length ? fail(`not in .gitignore: ${missing.join(", ")}`) : pass(`.gitignore has ${args.patterns.join(", ")}`);
  },
  async move_file(args, before, cwd) {
    return fs.existsSync(path.resolve(cwd, args.to)) && !fs.existsSync(path.resolve(cwd, args.from)) ? pass(`${args.from} → ${args.to}`) : fail(`${args.to} missing or ${args.from} still there`);
  },
  async remove_file(args, before, cwd) {
    const left = args.paths.filter((p) => fs.existsSync(path.resolve(cwd, p)));
    return left.length ? fail(`still on disk: ${left.join(", ")}`) : pass(`deleted: ${args.paths.join(", ")}`);
  },
  async clone(args, before, cwd) {
    const dir = path.resolve(cwd, args.dir || args.url.split(/[\\/:]/).pop().replace(/\.git$/, ""));
    if (!fs.existsSync(path.join(dir, ".git"))) return fail(`no repository at ${dir}`);
    if (args.depth) {
      const n = +(await quiet(["git", "rev-list", "--count", "HEAD"], dir)).out;
      if (n > args.depth) return fail(`cloned into ${dir}, but it has ${n} commits — not a depth-${args.depth} shallow clone`);
    }
    if (args.branch && (await quiet(["git", "branch", "--show-current"], dir)).out !== args.branch) return fail(`cloned, but not on branch ${args.branch}`);
    return pass(`cloned into ${dir}${args.depth ? ` (shallow, depth ${args.depth})` : ""}${args.branch ? ` on ${args.branch}` : ""}`);
  },
  async note_add(args, before, cwd) {
    const n = await quiet(["git", "notes", "show", args.ref || "HEAD"], cwd);
    return n.ok && n.out.includes(args.message) ? pass(`note on ${args.ref || "HEAD"}: "${args.message}"`) : fail("the note is not there");
  },
  async gh_repo_clone(args, before, cwd) {
    return VERIFIERS.clone({ url: args.repo, dir: args.dir }, before, cwd);
  },
  async worktree_add(args, before, cwd) {
    return fs.existsSync(path.resolve(cwd, args.path)) ? pass(`worktree at ${args.path} (${args.branch})`) : fail(`no worktree folder at ${args.path}`);
  },
  async archive(args, before, cwd) {
    const format = args.format || (/\.tar$/.test(args.output || "") ? "tar" : "zip");
    const file = path.resolve(cwd, args.output || `archive.${format}`);
    return fs.existsSync(file) && fs.statSync(file).size > 0 ? pass(`${file} written (${fs.statSync(file).size} bytes)`) : fail(`no archive at ${file}`);
  },
  async delete_remote_tag(args, before, cwd) {
    const r = await quiet(["git", "ls-remote", "--tags", args.remote || "origin", `refs/tags/${args.name}`], cwd);
    if (!r.ok) return unknown("could not reach the remote to confirm");
    return r.out ? fail(`tag ${args.name} still exists on the remote`) : pass(`tag ${args.name} no longer exists on the remote`);
  },
  async add(args, before, cwd) {
    // everything requested is staged: no unstaged edits and no untracked files left for those paths
    const scope = args.all || !args.paths ? ["."] : args.paths;
    const unstaged = (await quiet(["git", "diff", "--name-only", "--", ...scope], cwd)).out;
    const untracked = (await quiet(["git", "ls-files", "--others", "--exclude-standard", "--", ...scope], cwd)).out;
    const left = [unstaged, untracked].filter(Boolean).join("\n");
    if (left) return fail(`not staged: ${left.split("\n").slice(0, 5).join(", ")}`);
    const staged = (await quiet(["git", "diff", "--cached", "--name-only"], cwd)).out.split("\n").filter(Boolean);
    return pass(staged.length ? `staged: ${staged.slice(0, 6).join(", ")}${staged.length > 6 ? ` (+${staged.length - 6})` : ""}` : "nothing to stage");
  },
  async recover_commit(args, before, cwd, ctx) {
    const subject = (String(ctx.output).match(/subject: (.+)/) || [])[1]?.trim();
    if (!subject) return fail("no matching commit was found");
    const recent = (await quiet(["git", "log", "-30", "--format=%s"], cwd)).out.split(/\r?\n/);
    return recent.includes(subject) ? pass(`"${subject}" is back on ${(await snapshot(cwd)).branch}`) : fail(`"${subject}" is not on the current branch`);
  },
  async stash_apply(args, before, cwd) {
    return (await quiet(["git", "status", "--porcelain"], cwd)).out ? pass("stashed changes are back in your working tree (stash kept)") : fail("nothing was restored");
  },
  async unstage(args, before, cwd) {
    const staged = (await quiet(["git", "diff", "--cached", "--name-only", "--", ...(args.paths || ["."])], cwd)).out;
    return staged ? fail(`still staged: ${staged.split("\n").slice(0, 5).join(", ")}`) : pass(`nothing staged${args.paths ? ` for ${args.paths.join(", ")}` : ""}; edits kept`);
  },
  async gh_pr_checkout(args, before, cwd) {
    const b = (await snapshot(cwd)).branch;
    return b && b !== before.branch ? pass(`checked out PR #${args.number} on branch ${b}`) : fail("still on the same branch");
  },
});

/** Verifier for a raw `git …` command, when it maps to a known post-condition. */
export async function verifyRaw(argv, before, cwd) {
  const sub = argv[1];
  if (argv[0] !== "git") return null;
  if (sub === "push" && !argv.includes("--delete") && !argv.includes("-d") && !argv.includes("--tags")) return verifyPushed(cwd);
  if (sub === "commit") return VERIFIERS.commit({}, before, cwd);
  return null;
}

export const hasVerifier = (opId) => Object.hasOwn(VERIFIERS, opId);

/**
 * Ops whose check describes a GOAL STATE ("branch x is gone", "main is on the
 * remote"). Only these may turn a failed command into "already the case".
 * Ops that must CREATE something (commit, revert, stash, undo…) never qualify:
 * if the command failed, the new thing does not exist.
 */
const GOAL_STATE = new Set([
  "push", "sync", "pull", "push_tags", "delete_remote_branch", "branch_create", "branch_delete", "switch", "tag_create", "tag_delete",
  "remote_add", "remote_set_url", "remote_remove", "init", "untrack", "gitignore_add", "set_identity", "config_set", "discard", "restore_file",
  "clone", "gh_repo_clone", "gh_switch_account", "gh_repo_create", "gh_pr_create", "gh_pr_merge", "gh_pr_close", "gh_issue_close",
  "gh_release_create", "gh_repo_visibility", "branch_rename", "delete_remote_tag", "unstage",
]);
export const canBeAlreadyTrue = (opId) => GOAL_STATE.has(opId);

/** State captured before a step, so verifiers can compare. */
export async function captureBefore(cwd, snap) {
  return { ...snap, headSha: snap.isRepo && snap.hasCommits ? await headSha(cwd) : "" };
}

export async function verifyStep(step, before, cwd, ctx) {
  try {
    return await VERIFIERS[step.op.id](step.args, before, cwd, ctx);
  } catch (e) {
    return unknown(`verification crashed: ${e.message}`);
  }
}
