// GitCat's mascot: a composed, animated cat. Every frame is built from parts
// (ears, eyes, mouth, body, paws, tail) stamped onto a fixed canvas, plus
// props (thought bubble, laptop, magnifier, sparkles, zzz, rain...).
// Plain ASCII + a couple of 1-column glyphs so the art lines up in Windows
// Terminal, conhost, VS Code and macOS terminals alike.

export const CAT_W = 32;
export const CAT_H = 10;

// ---- parts ------------------------------------------------------------------
// Face template (rows 2..6 of the canvas). {L}{R} = eyes, {M} = mouth.
const EARS = {
  up: ["    /\\       /\\    ", "   /  \\_____/  \\   "],
  twitchL: ["   _/\\       /\\    ", "  /   \\_____/  \\   "],
  twitchR: ["    /\\       /\\_   ", "   /  \\_____/   \\  "],
  down: ["   __         __    ", "  (  \\_______/  )   "],
};
const face = (l, r, m) => [`  |   ${l}     ${r}   |  `, `  |  ==  ${m}  ==  |  `, "   \\___________/   "];

const EYES = {
  open: ["o", "o"],
  blink: ["-", "-"],
  happy: ["^", "^"],
  big: ["O", "O"],
  sleepy: ["u", "u"],
  closed: ["_", "_"],
  dizzy: ["@", "@"],
  focus: [">", "<"],
  lookL: ["o", "o"],
  sad: ["T", "T"],
  star: ["*", "*"],
  wink: ["^", "o"],
  squint: ["o", "O"],
  up: ["'", "'"],
};

// body + paws (rows 7..9); tail frames are merged onto the right edge
const BODY = {
  sit: ["    /           \\    ", "   |  |       |  |   ", "   (__|_______|__)   "],
  breatheIn: ["    /           \\    ", "   |  |       |  |   ", "   (__|_______|__)   "],
  breatheOut: ["   /             \\   ", "   |  |       |  |   ", "   (__|_______|__)   "],
  pawUp: ["    /           \\ _  ", "   |  |       | |/   ", "   (__|_______|__)   "],
  groom: ["    /  _        \\    ", "   |  ( )      |  |   ", "   (__|_______|__)   "],
  typeA: ["    /   _    _  \\    ", "   |  _(_)__(_)_ |   ", "  _[:::::::::::::]_  "],
  typeB: ["    /  _      _ \\    ", "   | (_)_____(_) |   ", "  _[:::::::::::::]_  "],
  hopUp: ["    /           \\    ", "    \\ |       | /    ", "     (_)     (_)     "],
};

const TAIL = [
  ["         ", "     _   ", "____/ )  "],
  ["     __  ", "    /  ) ", "___/  /  "],
  ["    _    ", "   ( \\   ", "___/ /   "],
  ["         ", "   __    ", "__/  )   "],
];
const TAIL_DOWN = ["         ", "         ", "______   "];

// ---- canvas -----------------------------------------------------------------
function blank() {
  return Array.from({ length: CAT_H }, () => " ".repeat(CAT_W));
}
function stamp(canvas, row, col, text) {
  if (row < 0 || row >= canvas.length) return;
  const line = canvas[row].padEnd(CAT_W);
  let out = line.slice(0, col);
  for (let i = 0; i < text.length && col + i < CAT_W; i++) {
    const ch = text[i];
    out += ch === "\u0000" ? line[col + i] : ch; // \0 = transparent
  }
  canvas[row] = (out + line.slice(col + text.length)).slice(0, CAT_W).padEnd(CAT_W);
}
const T = (s) => s.replace(/ /g, "\u0000"); // make spaces transparent for overlays

function drawCat(c, { ears = "up", eyes = "open", mouth = "ω", body = "sit", tail = 0, x = 1, y = 0, eyeShift = 0, tailDown = false } = {}) {
  const [l, r] = EYES[eyes] || EYES.open;
  const f = face(l, r, mouth);
  if (eyeShift) f[0] = eyeShift < 0 ? `  |  ${l}     ${r}    |  ` : `  |    ${l}     ${r}  |  `;
  const rows = [...EARS[ears], ...f, ...BODY[body]];
  rows.forEach((line, i) => stamp(c, 2 + y + i - (y > 0 ? 0 : 0), x, T(line)));
  const t = tailDown ? TAIL_DOWN : TAIL[tail % TAIL.length];
  t.forEach((line, i) => stamp(c, 7 + y + i, x + 18, T(line)));
}

// ---- moods ------------------------------------------------------------------
// Each mood is a function of the frame counter. ~8 fps (App ticks every 125ms).

const at = (tick, period) => Math.floor(tick / period);

const MOODS = {
  /** waiting for the user: tail swish, blinks, ear twitches, looks around, grooms */
  idle(t) {
    const c = blank();
    const cycle = t % 96;
    const eyes = cycle === 20 || cycle === 21 || cycle === 70 ? "blink" : cycle >= 40 && cycle < 48 ? "lookL" : "open";
    const eyeShift = cycle >= 40 && cycle < 44 ? -1 : cycle >= 44 && cycle < 48 ? 1 : 0;
    const ears = cycle >= 30 && cycle < 32 ? "twitchL" : cycle >= 80 && cycle < 82 ? "twitchR" : "up";
    const grooming = cycle >= 56 && cycle < 66;
    drawCat(c, { eyes: grooming ? "closed" : eyes, eyeShift, ears, body: grooming ? "groom" : at(t, 6) % 2 ? "breatheOut" : "breatheIn", tail: at(t, 3), mouth: grooming ? "w" : "ω" });
    if (grooming) stamp(c, 1, 22, T("lick lick"));
    return c;
  },
  /** idle for a long time: curled up asleep, zZz floating up */
  sleep(t) {
    const c = blank();
    drawCat(c, { eyes: "closed", ears: "up", body: at(t, 8) % 2 ? "breatheOut" : "breatheIn", tailDown: true, mouth: "-" });
    const z = at(t, 3) % 6;
    const trail = ["z", "Z", "z"];
    for (let i = 0; i < 3; i++) {
      const row = 3 - ((z + i * 2) % 6) / 2;
      if (row >= 0) stamp(c, Math.floor(row), 21 + i * 2, trail[i]);
    }
    return c;
  },
  /** startup: waves hello */
  hello(t) {
    const c = blank();
    drawCat(c, { eyes: t % 20 < 2 ? "blink" : "happy", body: at(t, 3) % 2 ? "pawUp" : "sit", tail: at(t, 2), mouth: "w" });
    stamp(c, 0, 20, T(".-------."));
    stamp(c, 1, 20, T("|  hi!  |"));
    stamp(c, 2, 19, T("<'-------'"));
    return c;
  },
  /** planning with the model: thought bubble, eyes up, head sway */
  thinking(t) {
    const c = blank();
    const sway = at(t, 5) % 4 === 1 ? 1 : at(t, 5) % 4 === 3 ? -1 : 0;
    drawCat(c, { x: 1 + (sway > 0 ? 1 : 0), eyes: t % 30 === 0 ? "blink" : "up", eyeShift: sway, tail: at(t, 4), mouth: "o" });
    const words = ["?", "git?", "hmm", "...", "push?", "merge?", "commit?", "branch?"];
    const w = words[at(t, 10) % words.length];
    stamp(c, 0, 21, T(`.${"-".repeat(w.length + 2)}.`));
    stamp(c, 1, 21, T(`( ${w} )`));
    stamp(c, 2, 19 + (at(t, 2) % 2), T("o"));
    stamp(c, 3, 18, T("."));
    return c;
  },
  /** writing a commit message: pencil scribbling on paper */
  writing(t) {
    const c = blank();
    drawCat(c, { eyes: "focus", tail: at(t, 3), mouth: "w", body: "pawUp" });
    const lines = ["~~~~  ", "~~~~~ ", "~~~   ", "~~~~~~"];
    stamp(c, 0, 22, T(".------."));
    for (let i = 0; i < 2; i++) stamp(c, 1 + i, 22, T(`|${(i <= at(t, 3) % 3 ? lines[(i + at(t, 3)) % 4] : "      ")}|`));
    stamp(c, 3, 22, T("'------'"));
    stamp(c, 3 - (at(t, 1) % 2), 20, T("/"));
    return c;
  },
  /** running a git command: typing on a laptop, screen shows a blinking prompt */
  running(t) {
    const c = blank();
    drawCat(c, { eyes: t % 24 === 0 ? "blink" : "focus", tail: at(t, 2), body: at(t, 1) % 2 ? "typeA" : "typeB", mouth: "w" });
    const cursor = at(t, 2) % 2 ? "_" : " ";
    const out = ["$ git", "$ git ", ">>>  ", "ok   "][at(t, 6) % 4];
    stamp(c, 0, 21, T(".---------."));
    stamp(c, 1, 21, T(`| ${(out + cursor).slice(0, 7).padEnd(7)} |`));
    stamp(c, 2, 21, T("'---------'"));
    const sparks = ["*", ".", "+", "'"];
    stamp(c, 7, 0, sparks[at(t, 1) % 4]);
    stamp(c, 6, 20, sparks[(at(t, 1) + 2) % 4]);
    return c;
  },
  /** checking the real state: magnifying glass sweeps across */
  verifying(t) {
    const c = blank();
    drawCat(c, { eyes: at(t, 3) % 2 ? "squint" : "big", tail: at(t, 3), mouth: "o" });
    const pos = [20, 22, 24, 22][at(t, 3) % 4];
    stamp(c, 0, pos, T(" _ "));
    stamp(c, 1, pos, T("(o)"));
    stamp(c, 2, pos + 1, T(" \\"));
    stamp(c, 3, pos + 2, T(" \\"));
    stamp(c, 1, 0, T(at(t, 4) % 2 ? "checking" : "        "));
    return c;
  },
  /** a command failed: sweat, spinning eyes, "!?" */
  debugging(t) {
    const c = blank();
    drawCat(c, { eyes: at(t, 3) % 2 ? "dizzy" : "focus", tail: at(t, 1), ears: at(t, 4) % 2 ? "twitchL" : "twitchR", mouth: "o" });
    stamp(c, 1, 20, T(["!?", "?!", "!!", "??"][at(t, 3) % 4]));
    stamp(c, 3 + (at(t, 2) % 2), 0, T(" '"));
    stamp(c, 0, 24, T("[fix]"));
    return c;
  },
  /** confirm box open: big eyes, paw raised, waiting on you */
  waiting(t) {
    const c = blank();
    drawCat(c, { eyes: t % 16 < 2 ? "blink" : "big", body: "pawUp", tail: at(t, 4), mouth: "o" });
    stamp(c, 0, 20, T(".-----."));
    stamp(c, 1, 20, T(at(t, 4) % 2 ? "| y/n |" : "|  ?  |"));
    stamp(c, 2, 20, T("'-----'"));
    return c;
  },
  /** verified success: hop + sparkles */
  success(t) {
    const c = blank();
    const hop = at(t, 2) % 2 === 0;
    drawCat(c, { y: hop ? -1 : 0, eyes: "happy", body: hop ? "hopUp" : "sit", tail: at(t, 1), mouth: "w" });
    const s = ["*", "+", ".", "*"];
    const k = at(t, 1);
    stamp(c, 0, 2 + (k % 3), s[k % 4]);
    stamp(c, 0, 22 - (k % 3), s[(k + 1) % 4]);
    stamp(c, 3, 26, s[(k + 2) % 4]);
    stamp(c, 5, 0, s[(k + 3) % 4]);
    stamp(c, 1, 24, T("yay!"));
    return c;
  },
  /** not done / failed: ears down, sad eyes, little rain cloud */
  sad(t) {
    const c = blank();
    drawCat(c, { ears: "down", eyes: "sad", tailDown: true, mouth: "-" });
    stamp(c, 0, 20, T(".-~~~~~-."));
    stamp(c, 1, 20, T("(_______)"));
    const r = at(t, 1) % 3;
    stamp(c, 2 + r, 21, T("'  '  '"));
    if (r < 2) stamp(c, 3 + r, 22, T("'  '"));
    return c;
  },
};

export const MOOD_NAMES = Object.keys(MOODS);

/** Frame lines (each exactly CAT_W wide) for a mood at a tick. */
export function catFrame(mood, tick) {
  const fn = MOODS[mood] || MOODS.idle;
  return fn(Math.max(0, tick | 0)).map((l) => l.replace(/\u0000/g, " ").padEnd(CAT_W).slice(0, CAT_W));
}

/** Pick the cat's mood from what the agent is doing right now. */
export function moodFor(status) {
  if (!status) return "idle";
  if (/^Running|Handing/.test(status)) return "running";
  if (/Verifying/.test(status)) return "verifying";
  if (/Diagnos/.test(status)) return "debugging";
  if (/commit message|Reading the output/.test(status)) return "writing";
  if (/Waking/.test(status)) return "sleep";
  return "thinking";
}

/** Short headline for the status panel next to the cat. */
export const MOOD_TITLE = {
  idle: "Ready when you are",
  sleep: "Napping… type anything to wake me",
  hello: "Hi! I'm GitCat",
  thinking: "Thinking about your request",
  writing: "Writing it down",
  running: "Running git for you",
  verifying: "Double-checking the real repo",
  debugging: "Something failed — investigating",
  waiting: "Waiting for your answer",
  success: "Done — and verified",
  sad: "That didn't work",
};
