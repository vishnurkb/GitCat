import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { render, Box, Text, Static, useApp, useInput } from "ink";
import { html, C, MODE_ORDER } from "./theme.js";
import { Header, Tips } from "./components/Header.js";
import { Item } from "./components/Item.js";
import { Busy } from "./components/Busy.js";
import { Confirm, confirmKey } from "./components/Confirm.js";
import { PromptInput } from "./components/PromptInput.js";
import { findSlash } from "./slash.js";
import { createAgent } from "../agent/agent.js";
import { snapshot } from "../agent/context.js";
import { modelLabel, providerOrder, listOllamaModels, warmup } from "../llm/index.js";
import { loadHistory, saveHistory, saveSettings } from "../config/settings.js";
import { SYSTEM_PROMPT } from "../agent/prompt.js";

const VERSION = "1.0.0";
let nextId = 1;

export function App({ settings, cwd: startCwd, initialRepo = null, llm }) {
  const { exit, suspendTerminal } = useApp();
  const [items, setItems] = useState([{ id: 0, type: "header" }]);
  const [staticKey, setStaticKey] = useState(0);
  const [status, setStatus] = useState(null);
  const [since, setSince] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmReq, setConfirmReq] = useState(null);
  const [cwd, setCwd] = useState(startCwd);
  const [repo, setRepo] = useState(initialRepo);
  const [, force] = useState(0);
  const [history, setHistory] = useState(() => loadHistory());
  const queue = useRef([]);

  const emit = useCallback((item) => setItems((prev) => [...prev, { ...item, id: nextId++ }]), []);
  const note = useCallback((text, tone = "info") => emit({ type: "note", text, tone }), [emit]);

  const ui = useMemo(
    () => ({
      status: (t) => {
        setStatus(t);
        if (t) setSince((s) => s || Date.now());
        else setSince(0);
      },
      emit,
      confirm: (request) => new Promise((resolve) => setConfirmReq({ request, resolve })),
      interactive: async (fn) => {
        let out;
        await suspendTerminal(async () => {
          out = await fn();
        });
        return out;
      },
      onCwd: (c) => setCwd(c),
    }),
    [emit, suspendTerminal],
  );

  const agent = useMemo(() => createAgent({ settings, cwd: startCwd, ui, ...(llm ? { llm } : {}) }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshRepo = useCallback(async () => setRepo(await snapshot(agent.cwd)), [agent]);

  // startup: repo info, model availability check, warm the local model
  useEffect(() => {
    refreshRepo();
    warmup(settings, SYSTEM_PROMPT);
    (async () => {
      const order = providerOrder(settings);
      const local = await listOllamaModels(settings);
      const groqOk = !!process.env.GROQ_API_KEY;
      const ollamaOk = local.includes(settings.ollamaModel);
      if (!groqOk && !ollamaOk)
        note(`No model ready: set GROQ_API_KEY in GitCat's .env, or run "ollama pull ${settings.ollamaModel}". Plain git commands and / shortcuts still work.`, "warn");
      else if (order[0] === "ollama" && !ollamaOk) note(`Local model ${settings.ollamaModel} not found — falling back to Groq. (ollama pull ${settings.ollamaModel})`, "warn");
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runAgent = useCallback(
    async (text, shown = text) => {
      emit({ type: "user", text: shown });
      setBusy(true);
      try {
        await agent.handle(text);
      } finally {
        setBusy(false);
        await refreshRepo();
        const next = queue.current.shift();
        if (next) setTimeout(() => handleSubmit(next), 0); // eslint-disable-line no-use-before-define
      }
    },
    [agent, emit, refreshRepo],
  );

  const clear = useCallback(() => {
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    setItems([{ id: nextId++, type: "header" }]);
    setStaticKey((k) => k + 1);
  }, []);

  const quit = useCallback(() => {
    saveHistory(history);
    emit({ type: "note", tone: "muted", text: "Bye! =^.^=" });
    setTimeout(() => exit(), 50);
  }, [exit, emit, history]);

  const handleSubmit = useCallback(
    (text) => {
      setHistory((h) => {
        const nh = h[h.length - 1] === text ? h : [...h, text];
        saveHistory(nh);
        return nh;
      });
      if (busy || agent.busy) {
        queue.current.push(text);
        note(`Queued: ${text}`, "muted");
        return;
      }
      if (text.startsWith("/")) {
        const found = findSlash(text);
        if (!found) return note(`Unknown command ${text.split(" ")[0]} — type / to see them all.`, "warn");
        const { cmd, arg } = found;
        if (cmd.prompt) return runAgent(cmd.prompt, text);
        emit({ type: "user", text });
        return cmd.run(
          {
            agent,
            settings,
            emit,
            note,
            clear,
            exit: quit,
            submit: (t) => runAgent(t, text),
            refresh: () => force((n) => n + 1),
          },
          arg,
        );
      }
      return runAgent(text);
    },
    [busy, agent, settings, emit, note, clear, quit, runAgent],
  );

  const cycleMode = useCallback(() => {
    settings.mode = MODE_ORDER[(MODE_ORDER.indexOf(settings.mode) + 1) % MODE_ORDER.length];
    saveSettings(settings);
    force((n) => n + 1);
  }, [settings]);

  // Confirm keys go through one permanent subscription gated by a ref that is
  // set during render — no gap between "box painted" and "box receives keys".
  const [confirmYes, setConfirmYes] = useState(true);
  const confirmRef = useRef(null);
  confirmRef.current = confirmReq;
  const yesRef = useRef(true);
  yesRef.current = confirmYes;
  useInput((input, key) => {
    const req = confirmRef.current;
    if (!req) return;
    const k = confirmKey(input, key);
    if (k === null) return;
    if (k === "toggle") return setConfirmYes((v) => !v);
    const ok = k === "enter" ? yesRef.current : k;
    confirmRef.current = null;
    setConfirmReq(null);
    setConfirmYes(true);
    req.resolve(ok);
  });

  return html`
    <${Box} flexDirection="column">
      <${Static} key=${staticKey} items=${items}>
        ${(item) =>
          item.type === "header"
            ? html`<${Box} key=${item.id} flexDirection="column"><${Header} cwd=${cwd} repo=${repo} model=${modelLabel(settings)} version=${VERSION} /><${Tips} /><//>`
            : html`<${Box} key=${item.id} paddingX=${1}><${Item} item=${item} /><//>`}
      <//>
      ${status && !confirmReq ? html`<${Box} paddingX=${1}><${Busy} status=${status} since=${since || Date.now()} /><//>` : null}
      ${confirmReq ? html`<${Box} paddingX=${1}><${Confirm} request=${confirmReq.request} yes=${confirmYes} /><//>` : null}
      <${PromptInput}
        active=${!confirmReq}
        busy=${busy}
        mode=${settings.mode}
        history=${history}
        onSubmit=${handleSubmit}
        onEscape=${() => busy && agent.cancel()}
        onCycleMode=${cycleMode}
        onCtrlC=${() => (busy ? agent.cancel() : quit())}
      />
      <${StatusLine} repo=${repo} cwd=${cwd} settings=${settings} />
    <//>
  `;
}

function StatusLine({ repo, settings }) {
  if (!repo) return null;
  const parts = [];
  if (repo.isRepo) {
    parts.push(html`<${Text} key="b" color=${C.green}>⎇ ${repo.branch || "detached"}<//>`);
    if (repo.ahead) parts.push(html`<${Text} key="a" color=${C.cyan}> ↑${repo.ahead}<//>`);
    if (repo.behind) parts.push(html`<${Text} key="bh" color=${C.yellow}> ↓${repo.behind}<//>`);
    const changes = repo.staged.length + repo.unstaged.length + repo.untracked.length;
    if (repo.inProgress) parts.push(html`<${Text} key="ip" color=${C.red}> · ${repo.inProgress} in progress<//>`);
    parts.push(html`<${Text} key="c" color=${changes ? C.orange : C.dim}> · ${changes ? `${changes} changed` : "clean"}<//>`);
  } else parts.push(html`<${Text} key="nr" color=${C.yellow}>not a git repo<//>`);
  parts.push(html`<${Text} key="m" color=${C.dim}> · ${modelLabel(settings)}<//>`);
  return html`<${Box} paddingX=${2}><${Text}>${parts}<//><//>`;
}

export async function startApp({ settings, cwd }) {
  const initialRepo = await snapshot(cwd);
  const app = render(html`<${App} settings=${settings} cwd=${cwd} initialRepo=${initialRepo} />`, { exitOnCtrlC: false });
  app.waitUntilExit().then(() => process.exit(0));
}
