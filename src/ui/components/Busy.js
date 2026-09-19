import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { html, C } from "../theme.js";
import { catFrame, moodFor, yarn } from "../cat.js";

/** Animated cat + what the agent is doing right now + elapsed time. */
export function Busy({ status, since }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 140);
    return () => clearInterval(t);
  }, []);
  const mood = moodFor(status);
  const [ears, face, body] = catFrame(mood, Math.floor(tick / 2));
  const secs = ((Date.now() - since) / 1000).toFixed(1);
  const color = { thinking: C.purple, running: C.green, debugging: C.orange, writing: C.cyan }[mood] || C.accent;
  return html`
    <${Box} flexDirection="row" marginTop=${1}>
      <${Box} flexDirection="column" marginRight=${1} width=${10}>
        <${Text} color=${C.accent}>${ears}<//>
        <${Text} color=${C.accent}>${face}<//>
        <${Text} color=${C.accent}>${body}<//>
      <//>
      <${Box} flexDirection="column" justifyContent="center">
        <${Text}> <//>
        <${Text}>
          <${Text} color=${color} bold>${status}<//>
          <${Text} color=${color}> ${yarn(tick)}<//>
        <//>
        <${Text} color=${C.dim}>${secs}s · esc to cancel<//>
      <//>
    <//>
  `;
}
