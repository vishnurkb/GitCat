// Two providers behind one call:
//   groq   — hosted, ~1000 tok/s, needs GROQ_API_KEY
//   ollama — local, private, works offline, needs the model pulled
// "auto" = local Ollama first when its model is pulled, Groq as fallback.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// Same num_ctx for warmup and chat: a different value makes Ollama reload the model.
const OLLAMA_CTX = 8192;

async function withTimeout(ms, fn, outer) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  const signal = outer ? AbortSignal.any([ac.signal, outer]) : ac.signal;
  try {
    return await fn(signal);
  } finally {
    clearTimeout(t);
  }
}

async function groqChat(settings, messages, { json, maxTokens, signal: outer }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not set");
  const model = settings.groqModel;
  const body = { model, messages, temperature: 0, max_completion_tokens: maxTokens };
  if (json) body.response_format = { type: "json_object" };
  if (/gpt-oss/.test(model)) {
    body.reasoning_effort = "low";
    body.include_reasoning = false;
  } else if (/qwen3/.test(model)) {
    body.reasoning_effort = "none";
  }
  const res = await withTimeout(20_000, (signal) =>
    fetch(GROQ_URL, { method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) }),
  outer);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`groq ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return { text: data.choices?.[0]?.message?.content ?? "", provider: "groq", model, usage: data.usage };
}

async function ollamaChat(settings, messages, { json, maxTokens, schema, signal: outer }) {
  const model = settings.ollamaModel;
  const body = {
    model,
    messages,
    stream: false,
    keep_alive: "30m", // keep weights + prompt cache warm between requests
    think: false,
    options: { temperature: 0, num_ctx: OLLAMA_CTX, num_predict: maxTokens },
  };
  if (json) body.format = schema || "json";
  const res = await withTimeout(90_000, (signal) =>
    fetch(`${settings.ollamaUrl}/api/chat`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  outer);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`ollama ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    text: data.message?.content ?? "",
    provider: "ollama",
    model,
    usage: { prompt_tokens: data.prompt_eval_count, completion_tokens: data.eval_count },
  };
}

/**
 * auto: local Ollama first when its model is pulled (no rate limits, private),
 * else Groq; the other one is the fallback. settings.ollamaReady is set by
 * detectProviders() at startup.
 */
export function providerOrder(settings) {
  if (settings.provider === "groq") return ["groq"];
  if (settings.provider === "ollama") return ["ollama"];
  if (settings.ollamaReady) return process.env.GROQ_API_KEY ? ["ollama", "groq"] : ["ollama"];
  return process.env.GROQ_API_KEY ? ["groq", "ollama"] : ["ollama"];
}

export async function detectProviders(settings) {
  const local = await listOllamaModels(settings);
  settings.ollamaReady = local.includes(settings.ollamaModel) || local.includes(`${settings.ollamaModel}:latest`);
  return { local, ollamaReady: settings.ollamaReady, groq: !!process.env.GROQ_API_KEY };
}

/** Chat with fallback. Returns {text, provider, model, ms}. Throws only if every provider failed. */
export async function chat(settings, messages, opts = {}) {
  const { json = false, maxTokens = 700, schema, signal } = opts;
  const errors = [];
  for (const p of providerOrder(settings)) {
    const t0 = Date.now();
    try {
      // messages may be a function of the provider (slim prompt for rate-limited Groq)
      const msgs = typeof messages === "function" ? messages(p) : messages;
      const r = p === "groq" ? await groqChat(settings, msgs, { json, maxTokens, signal }) : await ollamaChat(settings, msgs, { json, maxTokens, schema, signal });
      return { ...r, ms: Date.now() - t0 };
    } catch (e) {
      if (signal?.aborted) throw new Error("cancelled");
      errors.push(`${p}: ${e.name === "AbortError" ? "timed out" : e.message}`);
    }
  }
  throw new Error(`No model available — ${errors.join(" | ")}`);
}

/** Label for the header, e.g. "groq · gpt-oss-20b". */
export function modelLabel(settings) {
  const p = providerOrder(settings)[0];
  const m = p === "groq" ? settings.groqModel : settings.ollamaModel;
  return `${p} · ${m.replace(/^openai\//, "")}`;
}

/** Load the local model into memory so the first real request is fast. Fire-and-forget. */
export async function warmup(settings) {
  if (!providerOrder(settings).includes("ollama")) return;
  if (providerOrder(settings)[0] !== "ollama") return;
  try {
    await fetch(`${settings.ollamaUrl}/api/generate`, { method: "POST", body: JSON.stringify({ model: settings.ollamaModel, keep_alive: "30m", options: { num_ctx: OLLAMA_CTX } }) });
  } catch {
    /* ollama not running: chat() will report it */
  }
}

export async function listOllamaModels(settings) {
  try {
    const r = await withTimeout(2000, (signal) => fetch(`${settings.ollamaUrl}/api/tags`, { signal }));
    const d = await r.json();
    return (d.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

/** Pull the first JSON object out of a model reply (handles ```json fences and stray prose). */
export function extractJson(text) {
  const s = String(text || "").replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{");
  if (start < 0) throw new Error("no JSON object in reply");
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error("unterminated JSON in reply");
}
