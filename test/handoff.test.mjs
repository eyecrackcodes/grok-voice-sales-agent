import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, reduce, validate } from "../src/call-state.mjs";
import { HANDOFF_REQUIRES, FACTS } from "../src/flow.mjs";
import { nextDraftDate, parseBeneficiaries } from "../src/crm/dsb.mjs";

test("a complete application needs a verified address, SSN and bank on file, all set by the server", () => {
  for (const k of ["address_verified", "ssn_on_file", "bank_on_file"]) {
    assert.ok(HANDOFF_REQUIRES.includes(k), `${k} required for handoff`);
    assert.equal(FACTS[k].serverOnly, true, `${k} can't be set by the bot`);
  }
});

test("a prospect who chose a plan but won't finish the app can be transferred, ending as 290", () => {
  let at = 0;
  const steps = ["intro", "confirm", "agenda", "eligibility", "discovery"].map((to) => ({ type: "stage", to }));
  const facts = Object.entries({ marital_status: "single", protecting: "son", current_coverage: "none", pain: "son would pay", aligned: "yes", face_amount: "10000" })
    .map(([key, value]) => ({ type: "fact", key, value }));
  let s = initialState({ type: "call_started", callId: "t", at: at++ });
  for (const e of [...steps, ...facts.slice(0, 5), { type: "stage", to: "coverage" }, facts[5], { type: "stage", to: "health" },
    { type: "stage", to: "case_recap" }, { type: "fact", key: "case_confirmed", value: "yes" }, { type: "fact", key: "tier", value: "LEVEL" },
    { type: "stage", to: "quote" }, { type: "quote", tier: "LEVEL", options: [{ face: 10000, monthly: 50 }] }, { type: "stage", to: "price" },
    { type: "stage", to: "commit" }]) {
    const ev = { at: at++, ...e };
    assert.equal(validate(s, ev), null, JSON.stringify(e));
    s = reduce(s, ev);
  }
  assert.notEqual(validate(s, { type: "stage", to: "handoff", at }), null, "no handoff without a complete application");
  s = reduce(s, { type: "stage", to: "transferred", at });
  assert.equal(s.outcome, "transferred");
  assert.equal(s.crmStatus, 290);
});

test("first draft dates land on the Social Security day, at least 3 days out", () => {
  const today = new Date("2026-10-17T12:00:00");
  assert.equal(nextDraftDate("third Wednesday", today), "10/21/2026");
  assert.equal(nextDraftDate("2nd Wednesday", today), "11/11/2026");
  assert.equal(nextDraftDate("the 3rd", today), "11/03/2026");
  assert.equal(nextDraftDate("11/18/2026", today), "11/18/2026");
  assert.equal(nextDraftDate("whenever", today), null);
});

test("beneficiaries split evenly unless shares are stated", () => {
  assert.deepEqual(parseBeneficiaries("Karen Miller (daughter); Lisa Miller (daughter)").map((b) => b.beneficiary_ownership), ["50", "50"]);
  assert.deepEqual(parseBeneficiaries("Karen (daughter) 60%; Lisa (daughter) 40%").map((b) => b.beneficiary_ownership), ["60", "40"]);
  assert.equal(parseBeneficiaries("Bev Thompson (wife)")[0].beneficiary_relationship, "wife");
});

test("the CRM draft date uses the same lead time as the spoken date", async () => {
  const { MIN_LEAD_DAYS } = await import("../src/draft-date.mjs");
  const today = new Date(2026, 9, 18);
  assert.equal(nextDraftDate(`the ${18 + MIN_LEAD_DAYS}th`, today), `10/${18 + MIN_LEAD_DAYS}/2026`);
});
