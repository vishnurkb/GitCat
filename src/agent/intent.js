// Deterministic intent guard. A 4B model gets the op right far more often than
// it gets every parameter right, and a few parameters decide whether data is
// lost or code goes public. These rules read the user's actual words and
// correct those parameters — in both directions:
//   - FORCE what the user explicitly said ("keep THEIR version" -> theirs)
//   - STRIP dangerous flags the user never asked for (public, --force, --hard,
//     -D, --global) — the model's plan is not permission.
// Returns {steps, notes}; notes explain every correction to the user.
import { resolveStep } from "../catalog/index.js";

const has = (text, re) => re.test(text);

const W = {
  theirs: /\b(their|theirs|incoming|other (branch|side)'?s?|the branch being merged|accept (the )?incoming)\b/i,
  ours: /\b(mine|my (version|side|changes|copy)|ours|our (version|side)|keep (the )?current)\b/i,
  noSwitch: /\b(without switching|don'?t switch|do not switch|stay (here|on)|but stay|without checking (it )?out|not switch)\b/i,
  discard: /\b(throw (it |them )?away|discard|delete (the |those )?changes|don'?t (want|need) (those|the|these) changes|lose (the )?changes|completely|permanently|hard reset|--hard|nuke|wipe)\b/i,
  unstage: /\b(unstage|not staged|out of (the )?staging|keep (the )?files?( on disk)?\b(?!.*staged))/i,
  keepStash: /\b(keep (it|the stash|them)( in the (list|stash))?|without (removing|dropping|deleting)|leave (it|the stash))\b/i,
  public: /\b(public|open[- ]source|everyone can see|publicly)\b/i,
  force: /\b(force|overwrite (the )?remote|-f\b|--force)\b/i,
  forceDelete: /\b(force|anyway|even if (it'?s )?(not )?(un)?merged|unmerged|-D\b)\b/i,
  global: /\b(global(ly)?|all (my )?(repos|repositories|projects)|every (repo|project)|everywhere|--global|machine[- ]wide)\b/i,
};

function withArgs(step, patch) {
  const r = resolveStep({ op: step.op.id, args: { ...step.args, ...patch } });
  return r.error ? step : r;
}
function withoutArg(step, key) {
  const args = { ...step.args };
  delete args[key];
  const r = resolveStep({ op: step.op.id, args });
  return r.error ? step : r;
}

// "delete it", "remove that", "reset everything" — a destructive verb with no
// named target. Guessing the target is how a model deletes the wrong thing.
const VAGUE_DESTRUCTIVE = /^\s*(please\s+|pls\s+|just\s+)?(delete|remove|drop|discard|destroy|kill|nuke|wipe|clear|erase|undo|revert|reset)\s+(it|that|this|them|those|these|everything|all|all of (it|them))\s*(please|pls|now)?\s*[.!?]*\s*$/i;

/** "merge dev into main" -> {source: dev, target: main}; "merge dev" -> {source: dev} */
function mergeIntent(text) {
  let m = text.match(/\bmerge\s+(?:the\s+)?(?:branch\s+)?([\w./-]+)\s+(?:branch\s+)?(?:into|to|onto)\s+(?:the\s+)?(?:branch\s+)?([\w./-]+)/i);
  if (m) return { source: m[1], target: m[2] };
  m = text.match(/\b(?:bring|pull|get)\s+(?:the\s+)?(?:changes\s+(?:from|of)\s+)?([\w./-]+)\s+(?:changes\s+)?into\s+([\w./-]+)/i);
  if (m) return { source: m[1], target: m[2] };
  return null;
}

/** 'critical hotfix' / "fix login" — a commit named by its message. */
const quotedText = (text) => (text.match(/['"“‘`]([^'"”’`]{3,80})['"”’`]/) || [])[1];

export function applyIntentGuards(request, steps, snap = {}, turns = []) {
  const text = String(request || "");
  const notes = [];
  const branches = new Set([...(snap.branches || []), ...(snap.remoteBranches || [])]);

  // 0. "merge it / merge the PR" right after a PR was opened or listed means the
  //    GitHub pull request — not a local `git merge` of whatever branch.
  const prLink = [...turns].reverse().map((t) => (t.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/) || [])[1]).find(Boolean);
  if (prLink && /\bmerge\b/i.test(text) && /\b(it|that|this|the pr|pr|pull request)\b/i.test(text) && !mergeIntent(text) && !steps.some((s) => s.op.id === "gh_pr_merge")) {
    const merge = resolveStep({ op: "gh_pr_merge", args: { number: prLink, ...(/\bdelete\b/i.test(text) ? { delete_branch: true } : {}) } });
    notes.push(`"it" = pull request #${prLink} from earlier → merging that PR on GitHub`);
    return { steps: [merge], notes };
  }

  // 1. vague destructive request: ask, never guess
  if (VAGUE_DESTRUCTIVE.test(text) && steps.some((s) => s.risk !== "read")) {
    return { steps: [], notes, ask: "What exactly should I do that to? Name it — e.g. a branch, a tag, a stash, a file, the last commit, or a remote — and I'll show you the command before running it." };
  }

  // 2. merge direction: "merge X into Y" means be ON Y and merge X
  const mi = mergeIntent(text);
  if (mi && steps.some((s) => s.op.id === "merge")) {
    const { source, target } = mi;
    const fixed = [];
    let current = snap.branch;
    let changed = false;
    for (const s of steps) {
      if (s.op.id === "switch" && target && s.args.branch === source && s.args.branch !== target) {
        changed = true;
        continue; // model switched to the SOURCE branch — the wrong way round
      }
      if (s.op.id === "switch") current = s.args.branch;
      if (s.op.id === "merge") {
        if (target && current !== target) {
          fixed.push(resolveStep({ op: "switch", args: { branch: target } }));
          current = target;
          changed = true;
        }
        if (s.args.branch !== source) {
          changed = true;
          fixed.push(withArgs(s, { branch: source }));
          continue;
        }
      }
      fixed.push(s);
    }
    if (changed) {
      notes.push(`you said merge ${source}${target ? ` into ${target}` : ""} → ${target ? `on ${target}, ` : ""}merging ${source}`);
      steps = fixed;
    }
  }

  // 3. "... then show me what's staged / the diff / status": the model often
  // promises it in its reply and forgets the step
  const wantsShow = text.match(/\b(show|see|display|list|tell)\b[^.]*?\b(staged|diff|changes|status|branches|history|log)\b/i);
  if (wantsShow && steps.length && steps.every((s) => s.risk !== "read")) {
    const what = wantsShow[2].toLowerCase();
    const read =
      what === "staged" ? { op: "diff", args: { staged: true } } : what === "diff" || what === "changes" ? { op: "diff", args: {} } : what === "branches" ? { op: "branch_list", args: {} } : what === "history" || what === "log" ? { op: "log", args: {} } : { op: "status", args: {} };
    steps = [...steps, resolveStep(read)];
    notes.push(`you asked to see the ${what} → showing it after`);
  }

  const quoted = quotedText(text);
  const out = steps.map((s) => {
    const id = s.op.id;
    const a = s.args || {};
    if (id === "resolve_conflicts") {
      const wantTheirs = has(text, W.theirs) && !has(text, W.ours);
      const wantOurs = has(text, W.ours) && !has(text, W.theirs);
      if (wantTheirs && a.side !== "theirs") return note(withArgs(s, { side: "theirs" }), `you said "their/incoming" version → keeping theirs`);
      if (wantOurs && a.side !== "ours") return note(withArgs(s, { side: "ours" }), `you said "my/our" version → keeping ours`);
    }
    if (id === "branch_create" && has(text, W.noSwitch) && !a.stay) return note(withArgs(s, { stay: true }), "you said without switching → staying on the current branch");
    if (id === "undo_commit" || (id === "reset" && /^HEAD~\d*$/.test(a.ref || ""))) {
      if (has(text, W.discard)) {
        if (id === "undo_commit" && !a.discard) return note(withArgs(s, { discard: true, unstage: undefined }), "you asked to throw the changes away → hard reset");
        if (id === "reset" && a.mode !== "hard") return note(withArgs(s, { mode: "hard" }), "you asked to throw the changes away → hard reset");
      } else {
        if (id === "reset" && a.mode === "hard") return note(withArgs(s, { mode: "mixed" }), "you didn't ask to discard changes → keeping them (no --hard)");
        if (id === "undo_commit" && a.discard) return note(withoutArg(s, "discard"), "you didn't ask to discard changes → keeping them");
        if (id === "undo_commit" && has(text, W.unstage) && !a.unstage) return note(withArgs(s, { unstage: true }), "you asked to unstage too → changes kept as unstaged edits");
      }
    }
    if (id === "stash_apply" && !has(text, W.keepStash)) return note(resolveStep({ op: "stash_pop", args: { ...(a.index !== undefined ? { index: a.index } : {}) } }), "bringing work back removes it from the stash list (pop); say 'keep the stash' to keep it");
    if (id === "stash_pop" && has(text, W.keepStash)) return note(resolveStep({ op: "stash_apply", args: { ...(a.index !== undefined ? { index: a.index } : {}) } }), "you asked to keep the stash → apply instead of pop");
    if ((id === "gh_repo_create" || id === "gh_repo_visibility") && a.visibility === "public" && !has(text, W.public)) {
      return note(withArgs(s, { visibility: "private" }), "you didn't ask for a public repo → making it private");
    }
    if (id === "push" && a.force && !has(text, W.force)) return note(withoutArg(s, "force"), "you didn't ask to force push → normal push");
    if (id === "branch_delete" && a.force && !has(text, W.forceDelete)) return note(withoutArg(s, "force"), "you didn't ask to force delete → safe delete (git refuses if unmerged)");
    if ((id === "set_identity" || id === "config_set") && a.global && !has(text, W.global)) return note(withoutArg(s, "global"), "you didn't say global → setting it for this repo only");
    // "delete the tag on the remote" is not "push the tag"
    if (id === "push_tags" && /\b(delete|remove|drop)\b/i.test(text) && /\btag/i.test(text) && a.name) {
      return note(resolveStep({ op: "delete_remote_tag", args: { name: a.name, ...(a.remote ? { remote: a.remote } : {}) } }), `you asked to delete tag ${a.name} on the remote → deleting it there (not pushing it)`);
    }
    // a commit named by its message: a branch name here would mean "the branch tip" — the wrong commit
    const isHash = (r) => /^[0-9a-f]{7,40}$/i.test(r);
    if (quoted && id === "cherry_pick" && !a.refs.every(isHash) && a.refs[0] !== `:/${quoted}`) return note(withArgs(s, { refs: [`:/${quoted}`] }), `you named the commit "${quoted}" → picking exactly that commit`);
    if (quoted && (id === "revert" || id === "show") && a.ref && !isHash(a.ref) && a.ref !== `:/${quoted}`) return note(withArgs(s, { ref: `:/${quoted}` }), `you named the commit "${quoted}" → using exactly that commit`);
    return s;
  });
  function note(step, why) {
    notes.push(why);
    return step;
  }
  return { steps: out, notes };
}
