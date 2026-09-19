# Stack and tooling

## Stack

| Technology | Version | Used for | Why this one |
|---|---|---|---|
| Node.js | 24.18 (needs ≥22) | runtime | Previous project (`D:\github - cli ui`) was Node; Ink needs it. Startup ~0.3 s. |
| Ink | 7.1 | terminal UI | Same approach Claude Code uses: React components, `<Static>` transcript that doesn't re-render, `suspendTerminal` for `gh auth login`. |
| React | 19.3 | Ink peer | required by Ink 7 |
| htm | 3.1 | JSX-like templates | no build step — `node bin/gitcat.js` runs the source directly |
| execa | 10.0 | child processes | argv arrays (no shell = no injection), cancel signals, no-reject mode |
| Ollama + `qwen3:4b-instruct-2507-q4_K_M` | model 2.5 GB | default planner | measured 96% (48/50) plan accuracy, p50 0.88 s on RTX 4050; no rate limits; private |
| Groq `openai/gpt-oss-20b` | API | fallback planner | measured 92% (46/50), p50 0.91 s — but 8k tokens/min free-tier cap |
| node:test | built-in | tests | zero deps |
| ink-testing-library | 4.0 (dev) | TUI tests | renders the real App with a fake stdin |

## Agent tooling

| Name | Kind | Scope | What it does *here* | Setup |
|---|---|---|---|---|
| `project-docs` | skill | global (`~/.claude/skills`) | defined these docs, `check_docs.py`, launcher shape | none, machine-wide |
| `superpowers:*`, `vercel:*`, other plugins | plugins | global | unused here | — |

No MCP servers are used by this project.

## Rejected alternatives

| Option | Why not |
|---|---|
| Model returns **numbers** for boilerplates (original idea) | Same architecture, worse labels. A small model maps `"push"` → op `push` far more reliably than to "op 37"; numbers also break every time the catalog is reordered. Kept the idea (choose, don't write), used string ids. |
| Model writes shell commands directly | Needs a bigger model, can hallucinate flags, and every command is a shell-injection surface. Catalog + argv avoids all three. |
| Ollama JSON-schema constrained output | Ollama emits schema keys alphabetically, so `"ask"` came first and the model asked questions instead of acting: 70% accuracy vs 96% with plain JSON mode + validation. |
| Groq as primary | 8,000 tokens/minute on this key → ~2 requests/min with the full prompt. Kept as fallback with a slim, area-filtered catalog (~45% fewer tokens). |
| `qwen2.5:3b` / 1.7B models | not evaluated; 4B instruct fits 6 GB VRAM with room and scored 96%, so smaller wasn't needed. Cheap to revisit: `node scripts/eval.js ollama <model>`. |
| `@inquirer/prompts` (previous project) | menu-driven; this app needs a free-text prompt with a slash menu. |
