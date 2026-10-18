// Starts practice calls on the running server and prints each conversation when it ends.
// COST WARNING: practice calls spend real xAI credit, about $0.08 per minute of Grok Voice
// plus the prospect model (grok-4.3) tokens. The server allows PRACTICE_MAX_ACTIVE at once.
//   node scripts/roleplay.mjs dorothy earl
import { readFileSync } from "node:fs";
import { BASE, authHeaders } from "./local-api.mjs";
import { config } from "../src/config.mjs";
const personas = process.argv.slice(2).length ? process.argv.slice(2) : ["dorothy"];

async function run(persona) {
  const { callId } = await (await fetch(`${BASE}/roleplay`, {
    method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify({ persona }),
  })).json();
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await (await fetch(`${BASE}/calls/${callId}`, { headers: authHeaders() })).json();
    if (s.endedAt) break;
  }
  const events = readFileSync(new URL(`../data/calls/${callId}.jsonl`, import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const lines = events.map((e) =>
    e.type === "transcript" ? `${e.speaker === "bot" ? config.botName.toUpperCase() : persona.toUpperCase()}: ${e.text}`
    : e.type === "stage" ? `   >> ${e.to}`
    : e.type === "objection" ? `   !! objection ${e.kind}`
    : e.type === "quote" ? `   $$ ${e.options.map((o) => `${o.face}@${o.monthly}`).join("  ")}`
    : e.type === "call_ended" ? `   ## ended: ${e.reason}` : null).filter(Boolean);
  const final = await (await fetch(`${BASE}/calls/${callId}`, { headers: authHeaders() })).json();
  return `===== ${callId}: ${final.outcome} (lives ${final.livesLeft}, badges ${final.badges.join(", ")})\n${lines.join("\n")}`;
}

for (const out of await Promise.all(personas.map(run))) console.log(out + "\n");
