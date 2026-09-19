import { Box, Text } from "ink";
import { html, C } from "../theme.js";
import { catFrame } from "../cat.js";

const shortPath = (p) => {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const s = home && p.toLowerCase().startsWith(home.toLowerCase()) ? "~" + p.slice(home.length) : p;
  return s.length > 48 ? "…" + s.slice(-47) : s;
};

export function Header({ cwd, repo, model, version }) {
  const [ears, face, body] = catFrame("idle", 0);
  const branch = repo?.isRepo ? repo.branch || "detached" : null;
  return html`
    <${Box} borderStyle="round" borderColor=${C.accent} paddingX=${1} flexDirection="row" width=${Math.min(process.stdout.columns || 80, 110)}>
      <${Box} flexDirection="column" marginRight=${2}>
        <${Text} color=${C.accent}>${ears}<//>
        <${Text} color=${C.accent}>${face}<//>
        <${Text} color=${C.accent}>${body}<//>
      <//>
      <${Box} flexDirection="column">
        <${Text}><${Text} bold color=${C.accent}>GitCat<//><${Text} color=${C.dim}> v${version} · git in plain English<//><//>
        <${Text} color=${C.purple}>${shortPath(cwd)}<//>
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
      <${Text} color=${C.dim}>Tell me what you want in plain English — I pick the right git commands and run them.<//>
      <${Text} color=${C.dim}>
        <${Text} color=${C.cyan}>/<//> commands · <${Text} color=${C.cyan}>git …<//> runs directly · <${Text} color=${C.cyan}>shift+tab<//> mode · <${Text} color=${C.cyan}>esc<//> cancel · <${Text} color=${C.cyan}>ctrl+c<//> quit
      <//>
    <//>
  `;
}
