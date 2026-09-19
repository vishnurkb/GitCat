# Decisions

Append-only, newest first.

## 2026-09-20 — Deterministic intent guard on top of the model's plan
**Context:** A 73-prompt user-journey test (plain-English requests built from a developer's git cheat-sheet, judged by independent git/`gh api` checks) found the 4B model picks the right *operation* but slips on *parameters* that matter: "merge dev into main" ran as `switch dev; merge main` (reversed), "keep THEIR version" became `--ours`, "delete it" deleted a branch and a remote, "delete the tag on the remote" became `push` of the tag, cherry-picking a commit named by message used the branch tip.
**Decision:** `src/agent/intent.js` reads the user's actual words after planning and corrects those parameters (merge direction, conflict side, stay/switch, soft/mixed/hard, pop/apply, PR "it" from recent turns, commit-by-message via git's `:/text`), strips dangerous flags nobody asked for (public, `--force`, `--hard`, `-D`, `--global`), and turns vague destructive requests ("delete it") into a question. Every correction is shown to the user.
**Result:** journey 54/63 with 7 lies → 73/73 (incl. real GitHub PR/issue/release), 0 lies; stable on a second run.
**Also from that audit:** phantom `origin` branch in every clone (refname:short of origin/HEAD), undo on the first commit, commits without a message, commit messages that only saw the first 7k chars of the diff, PRs opened before unpushed commits were pushed, `pull` blocked by local edits (`--autostash`), `--depth` silently ignored for local paths, a failed commit "verified" because `rev-parse HEAD` prints the literal `HEAD` in an unborn repo, and the model's JSON with one extra `}` (now repaired before giving up).
**Trade-off:** English phrase rules; other languages rely on the model alone (Hinglish test passed via the model).

## 2026-09-20 — Always-on animated cat dock
**Context:** The user wanted a cat that is always visible, animates, and shows what the agent is doing.
**Decision:** `src/ui/cat.js` composes frames from parts (ears, eyes, mouth, body, tail) plus props per mood (thought bubble, laptop, magnifier, sparkles, zzz, rain); `CatDock` owns an ~8 fps timer so only the dock re-renders, decides the mood every frame (so "hello", success/sad reactions and napping expire on their own), and describes the current step in plain words. Verified in a real ConPTY terminal: 12 distinct frames in 4.8 s idle; all phases shown during a request.

## 2026-09-19 — "Done" requires a verified post-condition, not exit code 0
**Context:** The user's rule: the agent must never say yes unless the work really happened. Exit code 0 is not proof (`gh repo create` without `--push` exits 0 and leaves an empty repo).
**Decision:** `src/agent/verify.js` checks the real state after every state-changing step — `git ls-remote` for pushes/tags/branches (the remote itself, not the local tracking ref), `gh … --json` for repos/PRs/issues/releases, hosts.yml for account switches. Only verified steps produce "Done — verified"; unreachable checks produce "could NOT confirm"; failed checks produce "Request NOT completed". A failed command whose goal state is already true (branch already deleted) is reported as "already the case" — again only if the check passes.
**Evidence:** `scripts/github-e2e.js` on the real account: 20/20 steps independently confirmed via `gh api`, 0 lies, 0 under-claims. `FAKE_GH_LIE` test proves a 0-exit-code-but-nothing-pushed gh is reported as NOT completed.
**Also fixed by that run:** gh colorized `--json` output under `CLICOLOR_FORCE` (verification couldn't parse it); the auth-error fix flipped gh accounts for a repo that didn't exist — it now switches only when the repo owner is another logged-in account.
**Trade-off:** ~0.5–1 s extra per remote-affecting step (one ls-remote / gh call).

## 2026-09-19 — Post-release fixes from the first real session ("created repo, never pushed")
**Context:** User asked "create a private repo GitCat and push this folder". Result: empty GitHub repo, then the agent claimed "Yes, I pushed". Four bugs: (1) `gh_repo_create` dropped `--push` when the repo had no commits; (2) a known-error fix (add + commit) never retried the failed push; (3) "nothing to commit" aborted the rest of a plan, so `push` never ran; (4) the model's `reply` asserted success that never happened.
**Decision:** `gh_repo_create` makes the initial commit (and `git init`) itself; known fixes append the failed step + remaining steps; a clean-tree commit is skipped, not fatal; replies are intent-only, unfinished requests print "Request NOT completed"; "did you push?" is answered by `sync_check` (fetch + compare), never by the model; `cd` the user didn't ask for is dropped.
**Why tests missed it:** no test created a GitHub repo from an uncommitted folder, and no plan had a mid-plan failure. Added `test/fixtures/fake-gh.mjs` (via `GITCAT_GH_SHIM`) so GitHub flows now run end to end against a local bare repo, plus 7 regression tests.

## 2026-09-19 — Confirm-box keys routed by a render-time ref, not useInput isActive
**Context:** Ink swaps `useInput` subscriptions in effects, after paint. A "y" typed right as the confirm box appeared landed in the prompt instead (reproduced at ~600 ms in a test).
**Decision:** Prompt and confirm both subscribe permanently; each handler checks a ref set during render.
**Trade-off:** Two always-on listeners. **Revisit if:** Ink adds synchronous focus routing.

## 2026-09-19 — `resolve_conflicts` finishes the merge itself
**Context:** Real-model e2e: "keep my version and finish the merge" resolved the file but the model omitted `continue`, leaving MERGE_HEAD; the next "delete dev" then failed as unmerged.
**Decision:** When every conflict is resolved, the op appends the finishing command; `continue` is a no-op if nothing is in progress.
**Revisit if:** Users want to resolve files one at a time and inspect before concluding.

## 2026-09-19 — No JSON schema for Ollama; plain JSON + validation + one repair
**Context:** With `format: <schema>`, Ollama emitted keys alphabetically (`ask` first) and accuracy fell to 70%; the model asked "are you sure?" instead of planning.
**Decision:** `format: "json"`, validate each step against the catalog, one repair round with the exact error; ignore `ask` when steps exist (we confirm risky steps ourselves).
**Result:** 96% on the 50-case eval.

## 2026-09-19 — Local Ollama is the default provider, Groq the fallback
**Context:** Groq key is capped at 8k tokens/min for every model offered; full prompt ≈ 3.4k tokens.
**Decision:** `auto` = Ollama first when the model is pulled; Groq gets a slim prompt (only catalog areas the request mentions).
**Revisit if:** A paid Groq tier is used — then Groq could lead for machines without a GPU.

## 2026-09-19 — Catalog of string op ids instead of numbered boilerplates
**Context:** Original idea: model returns a boilerplate number + extra info.
**Decision:** Same "choose, don't write" design, but ids are names (`push`, `branch_create`) and params are typed specs; code builds argv. `git_raw`/`gh_raw` cover the long tail and are risk-classified.
**Trade-off:** Anything outside the catalog relies on the raw ops (still confirmed if dangerous).
