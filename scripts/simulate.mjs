import { readFile } from "node:fs/promises";
import { BASE, authHeaders } from "./local-api.mjs";

const args = process.argv.slice(2);
const file = args[0];
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const speed = Number(opt("--speed", 1));
const base = opt("--url", BASE);

if (!file || !(speed > 0)) {
  console.error("usage: node scripts/simulate.mjs <script.json> [--speed N] [--url http://127.0.0.1:4319]");
  process.exit(1);
}

const script = JSON.parse(await readFile(file, "utf8"));
const callId = `sim-${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const { delayMs, event } of script) {
  await sleep(delayMs / speed);
  const body = { ...event, callId, at: Date.now() };
  const res = await fetch(`${base}/calls/${callId}/events`, {
    method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!out.ok) console.log(`rejected ${event.type}${event.to ? ` -> ${event.to}` : ""}: ${out.error}`);
}
const final = await (await fetch(`${base}/calls/${callId}`, { headers: authHeaders() })).json();
console.log(`${callId} finished: stage=${final.stage} outcome=${final.outcome} crmStatus=${final.crmStatus} score=${final.score}`);
