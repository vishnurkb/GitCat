// `gitcat -p "request"` — one request, plain output, then exit. Used for
// scripting and for the end-to-end tests. Exit code 0 if everything that ran succeeded.
import readline from "node:readline/promises";
import { styleText } from "node:util";
import { createAgent } from "./agent/agent.js";

const paint = (fmt, s) => (process.stdout.isTTY || process.env.FORCE_COLOR ? styleText(fmt, s) : s);

export async function runHeadless({ request, settings, cwd, yes = false, json = false }) {
  const items = [];
  let failed = false;
  const ui = {
    status: () => {},
    emit: (item) => {
      items.push(item);
      if (item.type === "cmd" && !item.ok) failed = true;
      if ((item.type === "summary" || item.type === "verify") && item.ok !== true) failed = true;
      if (item.type === "note" && item.tone === "error") failed = true;
      if (item.type === "summary" && item.ok === true) failed = false; // an auto-fixed failure that verified is a success
      if (json) return;
      switch (item.type) {
        case "agent":
          console.log(paint("magentaBright", `● ${item.text}`));
          break;
        case "commitmsg":
          console.log(paint("cyan", `  ✎ commit message: ${item.text.split("\n")[0]}`));
          break;
        case "cmd":
          console.log(`${item.ok ? paint("green", "  ✔") : paint("red", "  ✖")} ${paint("bold", item.command)}`);
          if (item.output) console.log(item.output.split("\n").slice(0, 40).map((l) => "    " + l).join("\n"));
          break;
        case "verify":
          console.log(item.ok === true ? paint("green", `  ✔ verified: ${item.text}`) : item.ok === false ? paint("red", `  ✖ VERIFY FAILED: ${item.text}`) : paint("yellow", `  ⚠ could not verify: ${item.text}`));
          break;
        case "summary":
          console.log(paint(item.ok === true ? "green" : item.ok === false ? "red" : "yellow", `${item.ok === true ? "✔" : item.ok === false ? "✖" : "⚠"} ${item.text}`));
          break;
        case "diagnosis":
          console.log(paint("yellow", `  🩺 ${item.text}`));
          break;
        case "answer":
          console.log(paint("white", `  ${item.text}`));
          break;
        default:
          console.log(paint(item.tone === "error" ? "red" : "gray", `  ${item.text}`));
      }
    },
    confirm: async ({ title, commands, risk, warn }) => {
      items.push({ type: "confirm", title, commands, risk, warn });
      if (!json) {
        console.log(paint("yellow", `  ? ${title}${risk === "danger" ? "  [DANGEROUS]" : ""}`));
        for (const c of commands) console.log(paint("yellow", `    $ ${c}`));
        if (warn) console.log(paint("yellow", `    ⚠ ${warn}`));
      }
      if (yes) return true;
      if (!process.stdin.isTTY) return false;
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const a = await rl.question("    Proceed? (y/N) ");
      rl.close();
      return /^y/i.test(a.trim());
    },
    interactive: (fn) => fn(),
  };
  const agent = createAgent({ settings, cwd, ui });
  const t0 = Date.now();
  await agent.handle(request);
  if (json) console.log(JSON.stringify({ items, ms: Date.now() - t0, tokens: agent.state.tokens }));
  return failed ? 1 : 0;
}
