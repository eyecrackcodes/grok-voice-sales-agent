// COST WARNING: every run is a real Grok Voice practice call (about $0.08 per minute) plus several
// grok-4.3 grading passes per call. Runs x personas x grades adds up fast; confirm the spend first.
// Runs each persona several times against the live server and grades every call
// several times, reporting medians so script changes are judged on signal, not one lucky run.
//   node scripts/eval-discovery.mjs [--runs 3] [--grades 3] [dorothy earl frank gloria]
import { gradeLog } from "./grade-call.mjs";
import { BASE, authHeaders } from "./local-api.mjs";
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? Number(argv[argv.indexOf(k) + 1]) : d);
const RUNS = opt("--runs", 3), GRADES = opt("--grades", 3), CONCURRENCY = 3;
import { readFileSync } from "node:fs";
const endReason = (callId) => readFileSync(`data/calls/${callId}.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "call_ended")?.reason ?? "";
const personas = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const list = personas.length ? personas : ["dorothy", "earl", "frank", "gloria"];

async function runCall(persona) {
  const { callId } = await (await fetch(`${BASE}/roleplay`, {
    method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify({ persona }),
  })).json();
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    const s = await (await fetch(`${BASE}/calls/${callId}`, { headers: authHeaders() })).json();
    if (s.endedAt) return { persona, callId, outcome: s.outcome, furthest: s.trail.map((t) => t.stage).filter((x) => !["hangup", "callback", "dnc", "lost"].includes(x)).at(-1) };
  }
}

async function pool(items, fn, n) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : "n/a"; };

const all = await pool(list.flatMap((p) => Array(RUNS).fill(p)), runCall, CONCURRENCY);
// A harness failure says nothing about the script, so it is excluded and counted, never scored as a hangup.
const broken = all.filter((c) => endReason(c.callId).startsWith("roleplay error"));
const calls = all.filter((c) => !broken.includes(c));
if (broken.length) console.log(`EXCLUDED ${broken.length} harness failures: ${broken.map((c) => `${c.callId} (${endReason(c.callId)})`).join(", ")}`);
const graded = await pool(calls, async (c) => {
  const gs = await Promise.all(Array.from({ length: GRADES }, () => gradeLog(`data/calls/${c.callId}.jsonl`).catch(() => null)));
  const g = gs.filter(Boolean);
  return { ...c,
    discovery: median(g.map((x) => num(x.discovery))), needs: median(g.map((x) => num(x.needs))),
    finesse: median(g.map((x) => num(x.finesse.finesse))), self: median(g.map((x) => num(x.finesse.self_persuasion))),
    drama: median(g.map((x) => num(x.finesse.drama_risk))) };
}, 4);

console.log(`runs=${RUNS} grades=${GRADES}`);
for (const p of list) {
  const rows = graded.filter((r) => r.persona === p);
  const outcomes = rows.map((r) => `${r.outcome}@${r.furthest}`).join(", ");
  console.log(`${p.padEnd(8)} Discovery=${median(rows.map((r) => num(r.discovery)))} Needs=${median(rows.map((r) => num(r.needs)))} finesse=${median(rows.map((r) => num(r.finesse)))} self=${median(rows.map((r) => num(r.self)))} drama=${median(rows.map((r) => num(r.drama)))} | ${outcomes}`);
  for (const r of rows) console.log(`    ${r.callId} D=${r.discovery} N=${r.needs} F=${r.finesse} S=${r.self} R=${r.drama}`);
}
