#!/usr/bin/env node
import { loadSettings } from "../src/config/settings.js";
import { detectProviders } from "../src/llm/index.js";

const argv = process.argv.slice(2);
const flag = (...names) => names.some((n) => argv.includes(n));
const value = (...names) => {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  }
  return undefined;
};

if (flag("-h", "--help")) {
  console.log(`GitCat — AI git agent

  gitcat                       open the interactive agent in the current folder
  gitcat -p "commit and push"  run one request and exit
     --yes                     auto-approve confirmations (headless only)
     --json                    print a JSON transcript (headless only)
  --provider groq|ollama|auto  pick the model provider for this run
  --model <name>               override the model for the chosen provider
  --cwd <folder>               work in another folder`);
  process.exit(0);
}

const settings = loadSettings();
const provider = value("--provider");
if (provider) settings.provider = provider;
const model = value("--model");
if (model) {
  if (settings.provider === "ollama") settings.ollamaModel = model;
  else settings.groqModel = model;
}
const cwd = value("--cwd") || process.cwd();
await detectProviders(settings);
const request = value("-p", "--print");

if (request !== undefined) {
  const { runHeadless } = await import("../src/headless.js");
  process.exitCode = await runHeadless({ request, settings, cwd, yes: flag("--yes", "-y"), json: flag("--json") });
} else if (!process.stdin.isTTY) {
  console.error('gitcat: the interactive UI needs a real terminal. For scripts/pipes use: gitcat -p "your request"');
  process.exitCode = 2;
} else {
  const { startApp } = await import("../src/ui/App.js");
  startApp({ settings, cwd });
}
