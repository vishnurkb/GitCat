import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const HOME_DIR = process.env.GITCAT_HOME || path.join(os.homedir(), ".gitcat");
const SETTINGS_FILE = path.join(HOME_DIR, "settings.json");
export const HISTORY_FILE = path.join(HOME_DIR, "history.json");

// Keys live in GitCat's own folder (.env), not in the repo you run it in.
for (const f of [path.join(PKG_ROOT, ".env"), path.join(HOME_DIR, ".env")]) {
  try {
    if (fs.existsSync(f)) process.loadEnvFile(f);
  } catch {
    /* malformed .env: ignore, provider check will report missing key */
  }
}

export const DEFAULTS = {
  provider: process.env.GITCAT_PROVIDER || "auto", // auto | groq | ollama
  groqModel: process.env.GITCAT_GROQ_MODEL || "openai/gpt-oss-20b",
  ollamaModel: process.env.GITCAT_OLLAMA_MODEL || "qwen3:4b-instruct-2507-q4_K_M",
  ollamaUrl: process.env.OLLAMA_HOST ? (process.env.OLLAMA_HOST.startsWith("http") ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : "http://127.0.0.1:11434",
  mode: "auto", // auto: ask only for dangerous steps | confirm: ask for every change | yolo: never ask
};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    const { provider, groqModel, ollamaModel, mode } = s;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ provider, groqModel, ollamaModel, mode }, null, 2));
  } catch {
    /* settings are a convenience; never crash on write */
  }
}

export function loadHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(h) ? h.slice(-200) : [];
  } catch {
    return [];
  }
}

export function saveHistory(h) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(h.slice(-200)));
  } catch {
    /* ignore */
  }
}
