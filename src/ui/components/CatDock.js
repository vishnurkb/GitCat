import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { html, C } from "../theme.js";
import { catFrame, MOOD_TITLE, CAT_W } from "../cat.js";

const MOOD_COLOR = {
  idle: C.accent,
  sleep: C.purple,
  hello: C.accent,
  thinking: C.purple,
  writing: C.cyan,
  running: C.green,
  verifying: C.yellow,
  debugging: C.orange,
  waiting: C.yellow,
  success: C.green,
  sad: C.red,
};

const TIPS = [
  'Try: "commit my changes and push"',
  'Try: "make a branch called login-page"',
  'Try: "did you push?" — I check GitHub, I don\'t guess',
  'Try: "open a PR to main"',
  'Try: "undo my last commit but keep the work"',
  'Try: "stop tracking node_modules"',
  "Type / for commands · shift+tab changes when I ask first",
  'Try: "what changed since yesterday?"',
];

/**
 * Always-on mascot + "what I'm doing right now" panel. Owns its own ~8 fps
 * timer so only this component re-renders on each frame.
 */
const SLEEP_AFTER_MS = 90_000;

// Turn terse agent status into a sentence a person would say.
function describe(status) {
  if (!status) return status;
  if (/^Reading repo/.test(status)) return "Looking at your repo: branches, changes, remotes";
  if (/^Thinking/.test(status)) return "Choosing the right git operations for what you asked";
  if (/^Running (.*)/.test(status)) return `$ ${status.replace(/^Running /, "")}`;
  if (/^Verifying/.test(status)) return status.replace(/^Verifying (.*) against the real repo…/, "Checking that $1 really happened (not just exit code 0)");
  if (/^Diagnosing/.test(status)) return "Reading the error and working out a fix";
  if (/commit message/.test(status)) return "Reading your diff to write a good commit message";
  if (/^Reading the output/.test(status)) return "Summarising the results for you";
  return status;
}

export function CatDock({ baseMood, status: busyStatus, since, busy, flash, lastActive, startedAt }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 125);
    return () => clearInterval(t);
  }, []);
  // mood is re-decided every frame so time-based states (hello, reaction, nap) expire on their own
  const now = Date.now();
  const f = flash?.current && now < flash.current.until ? flash.current : null;
  let mood = baseMood;
  let status = describe(busyStatus);
  if (!mood) {
    if (f) {
      mood = f.mood;
      status = f.text;
    } else if (startedAt && now - startedAt.current < 3500) mood = "hello";
    else if (lastActive && now - lastActive.current > SLEEP_AFTER_MS) mood = "sleep";
    else mood = "idle";
  }
  if (f && !baseMood) busy = false; // reaction shown, request is over
  const frame = catFrame(mood, tick);
  const color = MOOD_COLOR[mood] || C.accent;
  const secs = since ? ((Date.now() - since) / 1000).toFixed(1) : null;
  const dots = ".".repeat((Math.floor(tick / 3) % 3) + 1).padEnd(3);
  const tip = TIPS[Math.floor(tick / 60) % TIPS.length];
  return html`
    <${Box} flexDirection="row" marginTop=${1}>
      <${Box} flexDirection="column" width=${CAT_W + 1} flexShrink=${0}>
        ${frame.map((l, i) => html`<${Text} key=${i} color=${color}>${l}<//>`)}
      <//>
      <${Box} flexDirection="column" justifyContent="center" flexShrink=${1}>
        <${Text} bold color=${color}>${MOOD_TITLE[mood] || MOOD_TITLE.idle}${busy ? dots : ""}<//>
        ${status ? html`<${Text} color=${C.text} wrap="truncate-end">${status}<//>` : null}
        ${busy && secs ? html`<${Text} color=${C.dim}>${secs}s · esc to cancel<//>` : null}
        ${!busy && !status ? html`<${Text} color=${C.dim} wrap="truncate-end">${tip}<//>` : null}
      <//>
    <//>
  `;
}
