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
  return (await quiet(["git", "rev-parse", "HEAD"], cwd)).out;
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
    return now && now !== before.headSha ? pass(`HEAD moved back to ${short(now)}; your changes are kept`) : fail("HEAD did not move");
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

export const hasVerifier = (opId) => Object.hasOwn(VERIFIERS, opId);

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
