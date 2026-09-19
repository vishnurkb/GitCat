import { saveSettings } from "../config/settings.js";
import { listOllamaModels, modelLabel, providerOrder } from "../llm/index.js";
import { MODE_ORDER, MODES } from "./theme.js";

// Slash commands. `prompt` = forward text to the agent (zero-token fast path
// handles most of these). `run` = handled locally by the UI.
// `arg` = placeholder shown in the menu; Enter completes instead of running.

export const SLASH = [
  { name: "help", desc: "what GitCat can do + shortcuts", run: (x) => x.emit({ type: "help" }) },
  { name: "status", desc: "working tree status", prompt: "status" },
  { name: "diff", desc: "show uncommitted changes", prompt: "diff" },
  { name: "log", desc: "recent commits", prompt: "log" },
  { name: "graph", desc: "branch graph", prompt: "graph" },
  { name: "branches", desc: "list branches", prompt: "branches" },
  { name: "commit", desc: "stage all + commit with an AI-written message", prompt: "commit all" },
  { name: "ship", desc: "stage all, commit, push — one go", prompt: "commit and push" },
  { name: "push", desc: "push current branch (sets upstream if needed)", prompt: "push" },
  { name: "pull", desc: "pull latest", prompt: "pull" },
  { name: "sync", desc: "pull --rebase then push", prompt: "sync" },
  { name: "undo", desc: "undo last commit, keep changes", prompt: "undo last commit" },
  { name: "stash", desc: "stash everything (incl. new files)", prompt: "stash" },
  { name: "unstash", desc: "pop the latest stash", prompt: "stash pop" },
  { name: "pr", desc: "open a pull request for this branch", prompt: "create a pull request for this branch" },
  { name: "repo", desc: "create a private GitHub repo from this folder + push", prompt: "put this project on github as a private repo" },
  { name: "account", desc: "GitHub accounts · /account switch", arg: "[switch]", run: (x, a) => x.submit(a.trim() === "switch" ? "switch account" : "github status") },
  { name: "init", desc: "git init here", prompt: "init" },
  { name: "cd", desc: "change working folder", arg: "<folder>", run: (x, a) => (a.trim() ? x.submit(`!cd ${a.trim()}`) : x.note("Usage: /cd <folder>", "warn")) },
  { name: "model", desc: "show/switch model · /model groq|ollama [name]", arg: "[groq|ollama] [model]", run: modelCmd },
  { name: "mode", desc: "auto | confirm | yolo — when to ask before running", arg: "[auto|confirm|yolo]", run: modeCmd },
  { name: "cost", desc: "model calls + tokens used this session", run: (x) => x.emit({ type: "cost", tokens: x.agent.state.tokens }) },
  { name: "clear", desc: "clear the screen", run: (x) => x.clear() },
  { name: "exit", desc: "quit GitCat", run: (x) => x.exit() },
];

async function modelCmd(x, argStr) {
  const [provider, ...rest] = argStr.trim().split(/\s+/).filter(Boolean);
  const s = x.settings;
  if (!provider) {
    const local = await listOllamaModels(s);
    x.note(
      `Model: ${modelLabel(s)}  (order: ${providerOrder(s).join(" → ")})\n` +
        `groq model: ${s.groqModel}${process.env.GROQ_API_KEY ? "" : "  (no GROQ_API_KEY)"}\n` +
        `ollama model: ${s.ollamaModel}${local.includes(s.ollamaModel) ? "" : "  (not pulled)"}\n` +
        `local models: ${local.join(", ") || "none / ollama not running"}\n` +
        `Switch: /model groq · /model ollama · /model auto · /model ollama <name>`,
      "info",
    );
    return;
  }
  if (!["groq", "ollama", "auto"].includes(provider)) return x.note("Usage: /model groq|ollama|auto [model]", "warn");
  s.provider = provider;
  if (rest.length && provider === "ollama") s.ollamaModel = rest.join(" ");
  if (rest.length && provider === "groq") s.groqModel = rest.join(" ");
  saveSettings(s);
  x.refresh();
  x.note(`Now using ${modelLabel(s)}`, "success");
}

function modeCmd(x, argStr) {
  const m = argStr.trim().toLowerCase();
  const next = MODE_ORDER.includes(m) ? m : MODE_ORDER[(MODE_ORDER.indexOf(x.settings.mode) + 1) % MODE_ORDER.length];
  x.settings.mode = next;
  saveSettings(x.settings);
  x.refresh();
  x.note(`Mode: ${next} — ${MODES[next].hint}`, next === "yolo" ? "warn" : "success");
}

/** Filter commands for the menu as the user types "/co…". */
export function matchSlash(text) {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const q = text.slice(1).toLowerCase();
  const starts = SLASH.filter((c) => c.name.startsWith(q));
  const contains = SLASH.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || c.desc.toLowerCase().includes(q)));
  return [...starts, ...contains];
}

export function findSlash(text) {
  const m = text.match(/^\/(\S+)\s*(.*)$/s);
  if (!m) return null;
  const cmd = SLASH.find((c) => c.name === m[1].toLowerCase());
  return cmd ? { cmd, arg: m[2] || "" } : null;
}
