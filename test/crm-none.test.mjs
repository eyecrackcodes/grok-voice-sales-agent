import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "crm-none-"));
process.env.CRM_DATA_DIR = dir;
const none = await import("../src/crm/none.mjs");

const state = {
  callId: "t-1", outcome: "won", stage: "handoff",
  facts: { first_name: "Pat", ssn_on_file: "•••-••-6789", bank_on_file: "Test Bank ••••4321 (checking)", pain: "call me at 555 123 4567 or 123456789" },
  quote: { options: [{ face: 10000, monthly: 50 }] }, objections: [{ kind: "price_too_high", resolved: true }],
  transcript: [{ speaker: "bot", text: "hello" }],
};

test("the queue starts from the example lead and copies it to leads.csv on first run", async () => {
  assert.equal(existsSync(join(dir, "leads.csv")), false);
  const leads = await none.listQueue();
  assert.equal(leads.length, 1);
  assert.match(leads[0].phone, /555/);
  assert.equal(existsSync(join(dir, "leads.csv")), true);
  assert.equal((await none.getLead("demo-1")).first_name, "Pat");
  assert.equal(await none.getLead("missing"), null);
});

test("a handoff lands in outcomes.jsonl with masked values only", async () => {
  await none.writeHandoff({ lead: { id: "demo-1" }, state, status: "complete" });
  const raw = readFileSync(join(dir, "outcomes.jsonl"), "utf8");
  const rec = JSON.parse(raw.trim().split("\n").at(-1));
  assert.equal(rec.type, "handoff");
  assert.equal(rec.status, "complete");
  assert.equal(rec.leadId, "demo-1");
  assert.doesNotMatch(raw, /123456789|555 123 4567/, "digit runs are scrubbed");
  assert.ok(!("ssn_on_file" in rec.facts), "masked SSN fact is not duplicated into facts");
});

test("a do-not-call outcome blocks the lead on later queue reads", async () => {
  await none.writeOutcome({ lead: { id: "demo-1" }, state: { ...state, outcome: "dnc" } });
  assert.equal((await none.getLead("demo-1")).dnc, true);
});
