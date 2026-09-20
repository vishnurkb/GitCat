# start_commands.md

> Last verified: 2026-09-20 on Windows 11 (Node 24.18.0, git 2.55.0, gh 2.96.0,
> Ollama with `qwen3:4b-instruct-2507-q4_K_M`, RTX 4050 6 GB). Every command
> below was run. The only NOT VERIFIED items are marked inline.

## Run it

| # | Directory | Command | Expect |
|---|---|---|---|
| 1 | the repo you want to work in | `gitcat` | cat banner, repo + branch, prompt box |
| 2 | — | type `status`, `/` for commands, or any request in plain English | commands run, results under `⎿` |

`gitcat` is a global command (installed once with `npm link`, see setup).
Or double-click **`start_project.bat`** — it asks which folder to open.
One request without the UI: `gitcat -p "commit and push"` (add `--yes` to auto-approve).

There are no ports — GitCat is a terminal app, so there is no `free_ports` script.

## Prerequisites

- **Node.js ≥ 22** (Ink 7 requires it) — tested on 24.18.0. `node --version`
- **git** on PATH — tested 2.55.0.
- **gh** (GitHub CLI), logged in — tested 2.96.0. `gh auth status`. Without it, GitHub ops fail; git ops still work.
- **A model** — at least one of:
  - **Ollama** (local, default when present): `ollama pull qwen3:4b-instruct-2507-q4_K_M` (2.5 GB, ~3.2 GB VRAM).
  - **Groq** key in `.env` (cloud fallback). Free tier = 8,000 tokens/minute → only ~3–4 requests/minute. Fine as backup, not as primary.

## First-time setup

```bash
cd "D:\Git AI Agent"
npm install
copy .env.example .env        # then put your GROQ_API_KEY in .env (optional if using Ollama)
npm link                      # makes `gitcat` available in every folder
ollama pull qwen3:4b-instruct-2507-q4_K_M
```

`.env` variables (all optional):

| Variable | Meaning |
|---|---|
| `GROQ_API_KEY` | Groq key (console.groq.com). Enables the cloud fallback. |
| `GITCAT_PROVIDER` | `auto` (default: Ollama if its model is pulled, else Groq), `ollama`, `groq` |
| `GITCAT_OLLAMA_MODEL` / `GITCAT_GROQ_MODEL` | override the model names |
| `OLLAMA_HOST` | Ollama URL if not `http://127.0.0.1:11434` |
| `GITCAT_HOME` | where settings/history live (default `~/.gitcat`); tests set this |

`.env` is read from GitCat's own folder (or `~/.gitcat/.env`), never from the repo you run it in.

## Verify

```bash
npm test                       # 76 tests: catalog, parsing, intent guard, agent e2e on real git (incl. fake GitHub + lying gh), TUI
node scripts/e2e.js ollama     # 18 real-model scenarios on throwaway repos (~35 s)
node scripts/eval.js ollama    # planner accuracy, 50 requests (~1 min)
```

User-journey and real-GitHub suites (the GitHub ones create private test repos on the active account — delete them afterwards):

```bash
node scripts/journey.js --local   # 63 real-user prompts on local repos (~3 min), independently checked
node scripts/journey.js           # + 10 on real GitHub: repo, PR, merge, issue, release, clone (~4.5 min)
node scripts/github-e2e.js        # 20 GitHub steps incl. account switching and negative cases (~2.5 min)
```

Expected (last run 2026-09-20): `ℹ pass 76 ℹ fail 0`; `18/18 scenarios passed`; `accuracy 49/50` (±1 run to run);
journey `73/73 prompts did the right thing`, `LIES: 0`; GitHub run `20/20`, `LIES: 0`, `Under-claims: 0`.
The journey creates 1 private `gitcat-journey-*` repo, github-e2e creates 2 `gitcat-e2e-*` repos.
Deleting test repos needs a token scope gh doesn't have by default: `gh auth refresh -h github.com -s delete_repo`, then `gh repo delete vishnurkb/<name> --yes`.
`node scripts/eval.js groq` takes ~11 minutes because it paces itself under Groq's rate limit.

## Using it

| You type | What happens |
|---|---|
| plain English | model picks ops → commands shown and run → failures diagnosed |
| `status`, `push`, `pull`, `log`, `diff`, `stash`, `commit and push`, `undo last commit` … | exact phrases skip the model entirely (0 tokens, instant) |
| `git …` / `gh …` | runs literally; dangerous ones (`reset --hard`, `push -f`…) still ask |
| `/` | command menu: `/commit /ship /push /pull /sync /undo /pr /repo /account /model /mode /cd /cost /help` … |
| `shift+tab` | mode: **auto** (ask only for dangerous) → **confirm** (ask for every change) → **yolo** |
| `esc` | cancel the running request · `↑/↓` history · `ctrl+c` quit |

## Stopping and resetting

- `ctrl+c` (or `/exit`) quits. `esc` cancels a running command.
- Reset settings + history: delete `%USERPROFILE%\.gitcat\`.
- Remove the global command: `npm unlink -g gitcat`.

## Troubleshooting (real failures hit while building this)

- **First request after boot takes ~25 s** — Ollama loading the model from disk. GitCat pre-warms it at startup; later requests are ~1 s.
- **`groq 429 … tokens per minute`** — the free Groq tier's 8k TPM. GitCat falls back to Ollama automatically in `auto` mode; with `/model groq` only, wait a minute.
- **`gitcat: the interactive UI needs a real terminal`** — stdin is piped. Use `gitcat -p "…"`.
- **Repo created but empty on GitHub** — fixed 2026-09-19 (see docs/decisions.md). `gh repo create` now makes the first commit itself. Verified with a fake gh in tests and on the real `vishnurkb/GitCat`. `gh auth login` (browser) is still NOT VERIFIED.
