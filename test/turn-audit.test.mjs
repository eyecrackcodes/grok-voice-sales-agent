import { test } from "node:test";
import assert from "node:assert/strict";
import { auditTurns } from "../scripts/turn-audit.mjs";

const bot = (text) => ({ type: "transcript", speaker: "bot", text });
const me = (text) => ({ type: "transcript", speaker: "prospect", text });
const stage = (to) => ({ type: "stage", to });

const events = [
  stage("intro"), bot("Hi, this is Sarah."), me("Hello."),
  bot("Thanks for taking my call."), stage("discovery"), bot("Do you have any coverage right now?"), me("No."),
  stage("health"), bot("Do you use tobacco?"), me("No."),
  bot("What do you take for your heart?"), me("[secure entry, not shown]"),
  bot("Got it. I will write that down."), me("Okay."),
  stage("transferred"), bot("Connecting you now, goodbye."),
];

test("a statement turn followed by the prospect is dead air, and consecutive bot lines are one turn", () => {
  const r = auditTurns(events);
  assert.deepEqual(r.deadAir.map((d) => [d.stage, d.text]), [["intro", "Hi, this is Sarah."], ["health", "I will write that down."]]);
  assert.equal(r.turns, 6);
});

test("yes/no questions are grouped by stage and only flagged outside data-capture stages", () => {
  const r = auditTurns(events);
  assert.deepEqual(Object.fromEntries(Object.entries(r.closed).map(([s, l]) => [s, l.length])), { discovery: 1, health: 1 });
  assert.deepEqual(r.flagged.map((f) => f.stage), ["discovery"]);
});

test("secure capture turns and the final goodbye are never dead air", () => {
  const r = auditTurns(events);
  assert.equal(r.deadAir.some((d) => /heart|Connecting/.test(d.text)), false);
});

test("an either/or question is a pick, not a closed question", () => {
  const r = auditTurns([stage("discovery"), bot("Are you married, single, or widowed?"), me("Widowed.")]);
  assert.deepEqual(r.flagged, []);
});
