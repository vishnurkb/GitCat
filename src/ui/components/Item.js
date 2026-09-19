import { Box, Text } from "ink";
import { html, C } from "../theme.js";
import { SLASH } from "../slash.js";

const MAX_LINES = 14;

function Output({ text, color }) {
  if (!text) return null;
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  const shown = lines.slice(0, MAX_LINES);
  const more = lines.length - shown.length;
  return html`
    <${Box} flexDirection="row" marginLeft=${2}>
      <${Text} color=${C.dim}>⎿  <//>
      <${Box} flexDirection="column">
        ${shown.map((l, i) => html`<${Text} key=${i} color=${color} wrap="truncate-end">${l || " "}<//>`)}
        ${more > 0 ? html`<${Text} color=${C.dim}>… +${more} more lines (run it yourself for the full output)<//>` : null}
      <//>
    <//>
  `;
}

const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);

export function Item({ item }) {
  switch (item.type) {
    case "user":
      return html`
        <${Box} marginTop=${1}>
          <${Text} color=${C.accent} bold>❯ <//><${Text} color=${C.text} bold>${item.text}<//>
        <//>`;
    case "agent":
      return html`
        <${Box} flexDirection="row">
          <${Text} color=${item.ask ? C.yellow : C.purple}>${item.ask ? "? " : "● "}<//>
          <${Box} flexDirection="column" flexShrink=${1}>
            <${Text}>${item.text}<//>
          <//>
        <//>`;
    case "cmd":
      return html`
        <${Box} flexDirection="column">
          <${Text}>
            <${Text} color=${item.ok ? C.green : C.red}>${item.ok ? "✔ " : "✖ "}<//>
            <${Text} bold color=${item.ok ? C.text : C.red}>${item.command.split("\n")[0]}${item.command.includes("\n") ? " …" : ""}<//>
            ${item.ms ? html`<${Text} color=${C.dim}>  ${ms(item.ms)}<//>` : null}
          <//>
          <${Output} text=${item.output} />
        <//>`;
    case "commitmsg":
      return html`
        <${Box} flexDirection="row">
          <${Text} color=${C.cyan}>✎ <//>
          <${Box} flexDirection="column">
            ${item.text.split("\n").map((l, i) => html`<${Text} key=${i} color=${i === 0 ? C.cyan : C.dim}>${l || " "}<//>`)}
          <//>
        <//>`;
    case "diagnosis":
      return html`
        <${Box} flexDirection="row" marginTop=${0}>
          <${Text} color=${C.orange}>🩺 <//>
          <${Box} flexShrink=${1}><${Text} color=${C.orange}>${item.text}<//><//>
        <//>`;
    case "answer":
      return html`
        <${Box} flexDirection="row" borderStyle="round" borderColor=${C.purple} paddingX=${1}>
          <${Text}>${item.text}<//>
        <//>`;
    case "help":
      return html`<${Help} />`;
    case "cost": {
      const t = item.tokens;
      return html`<${Text} color=${C.dim}>  ${t.calls} model calls · ${t.prompt} prompt + ${t.completion} completion tokens this session<//>`;
    }
    case "note":
    default: {
      const color = { error: C.red, warn: C.yellow, success: C.green, info: C.cyan, muted: C.dim }[item.tone] || C.dim;
      const icon = { error: "✖ ", warn: "⚠ ", success: "✔ ", info: "ℹ ", muted: "  " }[item.tone] || "  ";
      return html`
        <${Box} flexDirection="row">
          <${Text} color=${color}>${icon}<//>
          <${Box} flexShrink=${1}><${Text} color=${color}>${item.text}<//><//>
        <//>`;
    }
  }
}

function Help() {
  const examples = [
    "commit my changes and push",
    "make a branch called login-page from main",
    "undo the last commit but keep my work",
    "stop tracking node_modules",
    "merge dev into main",
    "put this on github as a private repo",
    "switch to my other github account",
    "what changed since yesterday?",
    "open a PR for this branch",
  ];
  return html`
    <${Box} flexDirection="column" borderStyle="round" borderColor=${C.cyan} paddingX=${1} marginTop=${1}>
      <${Text} bold color=${C.cyan}>Just say what you want. For example:<//>
      ${examples.map((e) => html`<${Text} key=${e} color=${C.text}>  • ${e}<//>`)}
      <${Text}> <//>
      <${Text} bold color=${C.cyan}>Slash commands<//>
      ${SLASH.map((c) => html`<${Text} key=${c.name}><${Text} color=${C.accent}>  /${c.name.padEnd(9)}<//><${Text} color=${C.dim}>${c.desc}<//><//>`)}
      <${Text}> <//>
      <${Text} color=${C.dim}>Type <${Text} color=${C.cyan}>git …<//> or <${Text} color=${C.cyan}>gh …<//> to run a command directly. ↑/↓ history · tab completes · shift+tab cycles mode · esc cancels<//>
    <//>`;
}
