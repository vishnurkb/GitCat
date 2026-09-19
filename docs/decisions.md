# Decisions

Append-only, newest first.

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
