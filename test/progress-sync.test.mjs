import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "progress-"));
process.env.CRM_DATA_DIR = dir;
process.env.VAULT_KEY = randomBytes(32).toString("base64");
process.env.DSB_BASE = "https://crm.example";
process.env.DSB_CRM_MCP = "test-token";
const { MILESTONES, progressTracker, namesMatch, serialQueue } = await import("../src/progress.mjs");
const dsb = await import("../src/crm/dsb.mjs");
const none = await import("../src/crm/none.mjs");
const { vaultPut } = await import("../src/vault.mjs");

const calls = [];
globalThis.fetch = async (url, init) => {
  const { name, arguments: args } = JSON.parse(init.body);
  calls.push({ name, args });
  const data = {
    leads_get: { first_name: "Maya", policies: [{ id: 9, policy_type: "570", status: "55" }] },
    states_list: [{ id: 36, name: "Ohio" }],
  }[name] ?? {};
  return { json: async () => ({ success: true, data }) };
};
beforeEach(() => { calls.length = 0; });

const vaultFiles = [];
const secure = (callId, fields) => { vaultPut(callId, fields); vaultFiles.push(new URL(`../data/vault/${callId}.enc`, import.meta.url)); };
after(() => { for (const f of vaultFiles) if (existsSync(f)) unlinkSync(f); });

const call = (id, { source = "outbound", first = "Maya", facts = {} } = {}) => ({
  callId: id, lead: { source }, outcome: null, stage: "recap", quote: null, objections: [], transcript: [], trail: [],
  facts: { first_name: first, state: "Ohio", date_of_birth: "03/04/1950", tobacco: "no", protecting: "her son", pain: "he would pay", ...facts },
});
const names = () => calls.map((c) => c.name);

test("only case_recap, price and recap are milestones, each handed out once", () => {
  assert.deepEqual(Object.keys(MILESTONES), ["case_recap", "price", "recap"]);
  const t = progressTracker();
  assert.equal(t.enter("health", true), null);
  assert.equal(t.enter("case_recap", true), "case_recap");
  assert.equal(t.enter("case_recap", true), null);
  assert.equal(t.enter("price", true), "price");
});

test("a milestone reached before the lead is known waits, the latest wins, and it is written once", () => {
  const t = progressTracker();
  assert.equal(t.enter("case_recap", false), null);
  assert.equal(t.enter("price", false), null);
  assert.equal(t.leadFound(), "price");
  assert.equal(t.leadFound(), null);
  assert.equal(t.enter("price", true), null);
});

test("dsb progress fills the fields and adds a note, with no status change and no SSN", async () => {
  secure("p-1", { ssn: "987654321", routing: "021000021", account: "000123456789", accountType: "checking", bank: "Test Bank" });
  const r = await dsb.writeProgress({ lead: { id: "L1" }, state: call("p-1"), stage: "case_recap" });
  assert.deepEqual(names(), ["leads_get", "states_list", "leads_update", "leads_add_note"]);
  assert.equal(r.stage, "case_recap");
  const update = calls.find((c) => c.name === "leads_update").args;
  assert.equal(update.first_name, "Maya");
  assert.equal(update.policy_id, 9);
  assert.ok(!JSON.stringify(calls).includes("987654321"), "the SSN is never sent mid-call");
  assert.ok(!JSON.stringify(calls).includes("000123456789"), "the account number is never sent mid-call");
  assert.match(calls.at(-1).args.note, /^AI call in progress \(Sarah\): needs and health captured/);
});

test("an inbound caller whose name differs from the lead gets a note only, for progress, handoff and outcome", async () => {
  const state = call("p-2", { source: "inbound", first: "Ann" });
  for (const write of [
    () => dsb.writeProgress({ lead: { id: "L1" }, state, stage: "price" }),
    () => dsb.writeHandoff({ lead: { id: "L1" }, state, status: "complete" }),
    () => dsb.writeOutcome({ lead: { id: "L1" }, state: { ...state, outcome: "dnc" } }),
  ]) {
    calls.length = 0;
    const r = await write();
    assert.equal(r.nameMismatch, true);
    assert.deepEqual(names(), ["leads_get", "leads_add_note"]);
    assert.match(calls.at(-1).args.note, /the caller gave the name "Ann" but this lead is "Maya"/);
  }
});

test("the name guard stays out of the way for a similar name, an unknown name, and any outbound call", async () => {
  for (const state of [call("p-3", { source: "inbound", first: "May" }), call("p-4", { source: "inbound", first: "" }), call("p-5", { source: "outbound", first: "Ann" })]) {
    calls.length = 0;
    await dsb.writeProgress({ lead: { id: "L1" }, state, stage: "price" });
    assert.ok(names().includes("leads_update"), state.callId);
  }
});

test("namesMatch ignores case and punctuation, accepts a shared first three letters, and cannot judge an empty name", () => {
  assert.equal(namesMatch("ANNE", " anne."), true);
  assert.equal(namesMatch("Katherine", "Kathy"), true);
  assert.equal(namesMatch("Mary-Ann", "Mary Ann"), true);
  assert.equal(namesMatch("Maya", "Maria"), false);
  assert.equal(namesMatch("Al", "Alan"), false);
  assert.equal(namesMatch("", "Maria"), true);
  assert.equal(namesMatch("Maya", undefined), true);
});

test("the handoff note carries full bank details only when CRM_BANK_IN_NOTE is on; otherwise bank name and last 4", async () => {
  secure("p-6", { ssn: "987654321", routing: "021000021", account: "000123456789", accountType: "checking", bank: "Test Bank" });
  const state = call("p-6");
  const noteOf = async () => { calls.length = 0; await dsb.writeHandoff({ lead: { id: "L1" }, state, status: "complete" }); return calls.find((c) => c.name === "leads_add_note").args.note; };

  const off = await noteOf();
  assert.ok(off.includes("Bank: Test Bank ••••6789 (checking), routing verified"));
  assert.ok(!off.includes("021000021") && !off.includes("000123456789"));
  assert.ok(calls.some((c) => c.name === "leads_update" && c.args.ssn === "987654321"), "the SSN still goes to the CRM's own field at handoff");

  process.env.CRM_BANK_IN_NOTE = "true";
  const on = await noteOf();
  delete process.env.CRM_BANK_IN_NOTE;
  assert.ok(on.includes("Bank draft: Test Bank, checking | Routing 021000021 (verified) | Account 000123456789"));
  assert.ok(!on.includes("987654321"), "the SSN is never in the note");
});

test("the draft date written to the CRM is never in the past", () => {
  const today = new Date(2026, 9, 18, 12);
  assert.equal(dsb.nextDraftDate("10/17/2026", today), null);
  assert.equal(dsb.nextDraftDate("10/18/2026", today), "10/18/2026");
  assert.equal(dsb.nextDraftDate("11/18/2026", today), "11/18/2026");
  assert.equal(dsb.nextDraftDate("third Wednesday", today), "10/21/2026");
});

test("none: progress is appended as its own record, and a name mismatch leaves a note instead", async () => {
  const lines = () => readFileSync(join(dir, "outcomes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  await none.writeProgress({ lead: { id: "demo-1", first_name: "Maya" }, state: call("p-7"), stage: "price" });
  const rec = lines().at(-1);
  assert.deepEqual([rec.type, rec.milestone, rec.label, rec.leadId], ["progress", "price", "quote presented", "demo-1"]);
  await none.writeProgress({ lead: { id: "demo-1", first_name: "Maya" }, state: call("p-8", { source: "inbound", first: "Ann" }), stage: "price" });
  assert.equal(lines().at(-1).type, "note");
  assert.match(lines().at(-1).text, /Details were not written to this lead/);
});

test("queued CRM writes run in order, so the handoff lands after a slow progress write, and a failure does not block the next", async () => {
  const queue = serialQueue(), order = [];
  const progress = queue(async () => { await new Promise((r) => setTimeout(r, 30)); order.push("progress"); });
  const failing = queue(async () => { throw new Error("crm down"); });
  const handoff = queue(async () => { order.push("handoff"); });
  await assert.rejects(failing, /crm down/);
  await Promise.all([progress, handoff]);
  assert.deepEqual(order, ["progress", "handoff"]);
});
