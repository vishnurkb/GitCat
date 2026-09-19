// The mascot. Plain ASCII (no emoji inside the art) so widths are identical
// in Windows Terminal, conhost, VS Code and macOS terminals.

const EARS = " /\\_/\\ ";

// face + body per mood; each mood cycles through its frames
const MOODS = {
  idle: [
    ["( o.o )", " > ^ < "],
    ["( o.o )", " > ^ < "],
    ["( o.o )", " > ^ < "],
    ["( -.- )", " > ^ < "],
  ],
  thinking: [
    ["( o.o )", " > ^ < ?"],
    ["( o.O )", " > ^ <  ?"],
    ["( O.o )", " > ^ < ?"],
    ["( o.o )", " > ^ <"],
    ["( -.- )", " > ^ < ."],
  ],
  running: [
    ["( ^.^ )", "/> ^ <\\"],
    ["( ^.^ )", "\\> ^ </"],
    ["( ^o^ )", "/> ^ <\\"],
    ["( ^.^ )", "\\> ^ </"],
  ],
  debugging: [
    ["( >.< )", " > ^ < !"],
    ["( o.O )", " > ^ <  ?"],
    ["( >.< )", " > ^ < !"],
    ["( -_- )", " > ^ <"],
  ],
  writing: [
    ["( o.o )", " > ^ <_/"],
    ["( o.o )", " > ^ <\\_"],
    ["( -.o )", " > ^ <_/"],
  ],
};

export function catFrame(mood, tick) {
  const frames = MOODS[mood] || MOODS.idle;
  const [face, body] = frames[tick % frames.length];
  return [EARS, face, body];
}

/** Pick a mood from the status text so the cat reacts to what the agent is doing. */
export function moodFor(status) {
  if (!status) return "idle";
  if (/^Running|Handing/.test(status)) return "running";
  if (/Diagnos/.test(status)) return "debugging";
  if (/commit message|Reading the output/.test(status)) return "writing";
  return "thinking";
}

// yarn ball rolling along — tiny progress flourish next to the status text
const YARN = ["·  ", "·· ", "···", " ··", "  ·", "   "];
export const yarn = (tick) => YARN[tick % YARN.length];
