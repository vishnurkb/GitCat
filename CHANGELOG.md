# Changelog

## 2026-09-20 — Honesty release: verification, intent guard, animated cat

Summary: GitCat no longer reports success from an exit code. After every change it
checks the real state (local refs, the remote via `ls-remote`, GitHub via `gh --json`)
and only then says "done". A deterministic intent guard reads the user's own words and
corrects the parameters a small model gets wrong (merge direction, ours/theirs,
soft/mixed/hard, public/private, force, global), and refuses to guess on vague
destructive requests. The mascot is now always on screen, animated, and narrates what
the agent is doing. Measured after the changes: 76/76 automated tests, 73/73 real-user
journey prompts verified against real git and real GitHub with 0 false "done" claims,
20/20 GitHub suite steps, 49/50 planner accuracy at ~0.9 s per plan.

### Added

| File | Why |
|---|---|
| `src/agent/verify.js` | "Exit code 0" is not proof: `gh repo create` without `--push` exits 0 and leaves an EMPTY repo. Post-condition checks per operation decide whether the work really happened. |
| `src/agent/intent.js` | The 4B model picks the right operation but slips on parameters that decide data loss or exposure. The user's words now override those parameters, and unrequested `--force`/`--hard`/`-D`/`--global`/public are stripped. |
| `src/ui/components/CatDock.js` | The cat had to be visible at all times and show current activity; it owns its own ~8 fps timer so only the dock repaints. |
| `scripts/journey.js` | 73 plain-English prompts covering a developer's everyday git cheat-sheet, each judged by an independent git/`gh api` check, reporting any false "done". |
| `scripts/github-e2e.js` | 20 steps against a real GitHub account (repo, PR, issue, merge, tag, release, account switch, negative cases) with independent checks. |
| `test/fixtures/fake-gh.mjs` | Lets GitHub flows run end to end in tests without touching a real account, including a `gh` that exits 0 but pushes nothing. |

### Changed

| File | Why |
|---|---|
| `src/agent/agent.js` | Run post-condition checks, report "NOT completed" honestly, stop replies that claim work that never ran, apply the intent guard, recover lost commits, and keep PR/issue links across turns so "merge it" resolves. |
| `src/agent/context.js` | `%(refname:short)` turned `origin/HEAD` into a bare `origin`, so every cloned repo showed a phantom local branch named "origin". Also adds commit count and default branch. |
| `src/agent/commitMessage.js` | The message only saw the first 7k characters of the diff, so a feature commit got labelled "docs:". Now every changed file is listed with a per-file diff budget. |
| `src/agent/knownErrors.js` | New deterministic diagnoses: branch checked out in another worktree, nothing to abort, local edits blocking a switch/pull (stash → retry → restore), and account switching only when the repo owner is another logged-in account. |
| `src/agent/prompt.js`, `src/agent/router.js` | Reference commits by message (`:/text`), answer "did you push?" from git instead of memory, and keep replies to intent rather than claims. |
| `src/catalog/*.js` | `gh_repo_create` makes the first commit and slugifies names the way GitHub does; PRs push unpushed commits first; `undo_commit` gains keep/unstage/discard; `discard` clears staged edits too; `pull --autostash`; plus log search, remote show, bisect, archive, notes, shallow/branch clone and remote tag deletion. |
| `src/llm/index.js` | Repairs the model's almost-JSON (one extra `}`, repeated identically on retry), keeps Ollama's KV cache warm, and sends a slim prompt to rate-limited Groq. |
| `src/exec/run.js` | Verification needs machine-readable output: colors are disabled when a command's result is parsed. |
| `src/ui/*` | Wordmark header, always-on animated cat with 11 moods, plain-English activity text, verification and summary lines in the transcript. |
| `docs/*`, `start_commands.md` | Kept in step with the code: architecture, structure, decisions and the verification commands. |
| `test/*` | Regressions for every bug above, including "gh exits 0 but pushed nothing must NOT be reported as done". |

### Removed

| File | Why |
|---|---|
| `src/ui/components/Busy.js` | Replaced by the always-visible `CatDock`, which covers both idle and busy states. |
