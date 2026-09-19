import { Box, Text } from "ink";
import { html, C } from "../theme.js";

const shortPath = (p) => {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const s = home && p.toLowerCase().startsWith(home.toLowerCase()) ? "~" + p.slice(home.length) : p;
  return s.length > 48 ? "…" + s.slice(-47) : s;
};

// Wordmark (the live, animated cat sits in the dock above the prompt).
const LOGO = [
  "  ___ _ _    ___      _   ",
  " / __(_) |_ / __|__ _| |_ ",
  "| (_ | |  _| (__/ _` |  _|",
  " \\___|_|\\__|\\___\\__,_|\\__|",
];
const LOGO_COLORS = [C.accent, C.accent, C.purple, C.purple];

export function Header({ cwd, repo, model, version }) {
  const branch = repo?.isRepo ? repo.branch || "detached" : null;
  return html`
    <${Box} borderStyle="round" borderColor=${C.accent} paddingX=${1} flexDirection="row" width=${Math.min(process.stdout.columns || 80, 110)}>
      <${Box} flexDirection="column" marginRight=${3} flexShrink=${0}>
        ${LOGO.map((l, i) => html`<${Text} key=${i} bold color=${LOGO_COLORS[i]}>${l}<//>`)}
      <//>
      <${Box} flexDirection="column" justifyContent="center">
        <${Text}><${Text} color=${C.dim}>v${version} · git in plain English · =^.^=<//><//>
        <${Text} color=${C.purple} wrap="truncate-start">${shortPath(cwd)}<//>
        <${Text}>
          <${Text} color=${branch ? C.green : C.yellow}>${branch ? `⎇ ${branch}` : "not a git repo"}<//>
          <${Text} color=${C.dim}> · ${model}${repo?.ghUser ? " · gh:" : ""}<//>
          <${Text} color=${C.cyan}>${repo?.ghUser || ""}<//>
        <//>
      <//>
    <//>
  `;
}

export function Tips() {
  return html`
    <${Box} flexDirection="column" paddingX=${1} marginBottom=${1}>
      <${Text} color=${C.dim}>Tell me what you want in plain English — I pick the right git commands, run them, and check the result.<//>
      <${Text} color=${C.dim}>
        <${Text} color=${C.cyan}>/<//> commands · <${Text} color=${C.cyan}>git …<//> runs directly · <${Text} color=${C.cyan}>shift+tab<//> mode · <${Text} color=${C.cyan}>esc<//> cancel · <${Text} color=${C.cyan}>ctrl+c<//> quit
      <//>
    <//>
  `;
}
