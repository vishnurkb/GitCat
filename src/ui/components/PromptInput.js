import { useRef, useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { html, C, MODES } from "../theme.js";
import { matchSlash } from "../slash.js";

const PLACEHOLDERS = ['Try "commit my changes and push"', 'Try "make a branch for the login feature"', 'Try "what did I change today?"', "Type / for commands"];
const MENU_SIZE = 7;

/**
 * Single-line editor (wraps visually). Owns: text, cursor, slash menu,
 * history navigation. Calls onSubmit(text) on Enter.
 */
export function PromptInput({ active, busy, mode, history, onSubmit, onEscape, onCycleMode, onCtrlC }) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [sel, setSel] = useState(0);
  const [histIdx, setHistIdx] = useState(-1); // -1 = editing a fresh line
  const [draft, setDraft] = useState("");
  const [ph] = useState(() => PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)]);

  const matches = matchSlash(value);
  const menuOpen = matches.length > 0 && active;
  const selIdx = Math.min(sel, Math.max(0, matches.length - 1));

  const set = (v, c = v.length) => {
    setValue(v);
    setCursor(Math.max(0, Math.min(c, v.length)));
    setSel(0);
  };

  const insert = (text) => {
    const clean = text.replace(/\r?\n/g, " ").replace(/\t/g, " ");
    set(value.slice(0, cursor) + clean + value.slice(cursor), cursor + clean.length);
  };

  const submit = (text) => {
    set("");
    setHistIdx(-1);
    onSubmit(text);
  };

  // Always subscribed; gated by a ref set during render (see Confirm.js for why).
  const activeRef = useRef(active);
  activeRef.current = active;

  usePaste((text) => activeRef.current && insert(text));

  useInput(
    (input, key) => {
      if (!activeRef.current) return;
      if (key.ctrl && input === "c") {
        if (value) return set("");
        return onCtrlC();
      }
      if (key.escape) {
        if (menuOpen || value) return set("");
        return onEscape();
      }
      if (key.shift && key.tab) return onCycleMode();

      if (menuOpen) {
        if (key.upArrow) return setSel((selIdx - 1 + matches.length) % matches.length);
        if (key.downArrow) return setSel((selIdx + 1) % matches.length);
        if (key.tab || (key.return && matches[selIdx].arg)) {
          const c = matches[selIdx];
          return set(`/${c.name}${c.arg ? " " : ""}`);
        }
        if (key.return) return submit(`/${matches[selIdx].name}`);
      }

      if (key.return) {
        if (value.trim()) submit(value.trim());
        return;
      }
      if (key.upArrow || key.downArrow) {
        if (!history.length) return;
        let idx = histIdx;
        if (key.upArrow) {
          if (idx === -1) {
            setDraft(value);
            idx = history.length - 1;
          } else idx = Math.max(0, idx - 1);
        } else {
          if (idx === -1) return;
          idx = idx + 1;
          if (idx >= history.length) {
            setHistIdx(-1);
            return set(draft);
          }
        }
        setHistIdx(idx);
        return set(history[idx]);
      }
      if (key.leftArrow) return setCursor((c) => Math.max(0, c - (key.ctrl || key.meta ? c - wordStart(value, c) || 1 : 1)));
      if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1));
      if (key.home || (key.ctrl && input === "a")) return setCursor(0);
      if (key.end || (key.ctrl && input === "e")) return setCursor(value.length);
      if (key.ctrl && input === "u") return set(value.slice(cursor), 0);
      if (key.ctrl && input === "k") return set(value.slice(0, cursor), cursor);
      if (key.ctrl && input === "w") {
        const ws = wordStart(value, cursor);
        return set(value.slice(0, ws) + value.slice(cursor), ws);
      }
      // Many Windows terminals report Backspace as "delete" — treat both as backspace.
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        return set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      }
      if (key.tab || key.ctrl || key.meta) return;
      if (input) insert(input);
    },

  );

  const m = MODES[mode] || MODES.auto;
  const before = value.slice(0, cursor);
  const at = value[cursor] || " ";
  const after = value.slice(cursor + 1);
  const start = Math.max(0, Math.min(selIdx - Math.floor(MENU_SIZE / 2), matches.length - MENU_SIZE));
  const visible = matches.slice(start, start + MENU_SIZE);
  const labelWidth = Math.max(0, ...visible.map((c) => c.name.length + 1 + (c.arg ? c.arg.length + 1 : 0)));

  return html`
    <${Box} flexDirection="column" marginTop=${1}>
      <${Box} borderStyle="round" borderColor=${active ? (busy ? C.dim : C.accent) : C.dim} paddingX=${1}>
        <${Text} color=${C.accent} bold>❯ <//>
        ${
          value
            ? html`<${Text} wrap="wrap">${before}<${Text} inverse>${active ? at : ""}<//>${after}<//>`
            : html`<${Text}><${Text} inverse>${active ? " " : ""}<//><${Text} color=${C.dim}>${busy ? "working… (you can type the next request)" : ph}<//><//>`
        }
      <//>
      ${
        menuOpen
          ? html`<${Box} flexDirection="column" paddingX=${2}>
              ${visible.map((c) => {
                const on = c === matches[selIdx];
                const label = `/${c.name}${c.arg ? " " + c.arg : ""}`;
                return html`<${Text} key=${c.name} wrap="truncate-end">
                  <${Text} color=${on ? C.accent : C.cyan} bold=${on}>${on ? "❯ " : "  "}${label.padEnd(labelWidth)}<//>
                  <${Text} color=${on ? C.text : C.dim}>  ${c.desc}<//>
                <//>`;
              })}
              ${matches.length > MENU_SIZE ? html`<${Text} color=${C.dim}>  ↑↓ ${matches.length} commands<//>` : null}
            <//>`
          : html`<${Box} paddingX=${2}>
              <${Text} color=${m.color}>${m.icon} ${m.label}<//><${Text} color=${C.dim}> — ${m.hint} (shift+tab) · / commands · ↑ history<//>
            <//>`
      }
    <//>
  `;
}

function wordStart(s, c) {
  let i = c;
  while (i > 0 && s[i - 1] === " ") i--;
  while (i > 0 && s[i - 1] !== " ") i--;
  return i;
}
