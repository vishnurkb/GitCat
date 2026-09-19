import { Box, Text } from "ink";
import { html, C, RISK_COLOR } from "../theme.js";

/**
 * Inline approval box (presentational). Keys are handled by App through a
 * permanent input subscription — toggling useInput subscriptions leaves a
 * few-ms window after paint where a fast "y" lands in the prompt instead.
 */
export function Confirm({ request, yes }) {
  const color = RISK_COLOR[request.risk] || C.yellow;
  const danger = request.risk === "danger";
  return html`
    <${Box} flexDirection="column" borderStyle="round" borderColor=${color} paddingX=${1} marginTop=${1}>
      <${Text} bold color=${color}>${danger ? "⚠  " : ""}${request.title}${danger ? "  (destructive)" : ""}<//>
      ${request.commands.map((c, i) => html`<${Text} key=${i} color=${C.text}>  $ ${c}<//>`)}
      ${request.warn ? html`<${Text} color=${C.orange}>  ${request.warn}<//>` : null}
      <${Box} marginTop=${1}>
        <${Text} inverse=${yes} color=${yes ? C.green : C.dim}> ${yes ? "❯ " : "  "}Yes, run it <//>
        <${Text}>   <//>
        <${Text} inverse=${!yes} color=${!yes ? C.red : C.dim}> ${!yes ? "❯ " : "  "}No <//>
        <${Text} color=${C.dim}>   y/n · ←/→ · enter<//>
      <//>
    <//>
  `;
}

/** Key handling for the confirm box. Returns true/false to answer, or "toggle". */
export function confirmKey(input, key) {
  if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.tab) return "toggle";
  if (key.return) return "enter";
  if (key.escape || input.toLowerCase() === "n") return false;
  if (input.toLowerCase() === "y") return true;
  return null;
}
