import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initialState, reduce, validate } from "../src/call-state.mjs";
import { HANDOFF_REQUIRES, OBJECTION_LIMIT } from "../src/flow.mjs";

let clock = 0;
const at = () => (clock += 1000);
const started = () => ({ type: "call_started", callId: "t", at: at(), lead: { name: "Margaret" } });

// Applies events in order and fails the test if any is rejected, so the setup is itself checked.
function play(events, state = initialState(started())) {
  for (const e of events) {
    const ev = { at: at(), ...e };
    const why = validate(state, ev);
    assert.equal(why, null, `setup event rejected: ${JSON.stringify(e)} (${why})`);
    state = reduce(state, ev);
  }
  return state;
}

const stage = (to) => ({ type: "stage", to });
const fact = (key, value) => ({ type: "fact", key, value });
const toDiscovery = [stage("intro"), stage("confirm"), stage("agenda"), stage("eligibility"), stage("discovery")];
const discoveryFacts = [
  fact("marital_status", "single"), fact("protecting", "two daughters"),
  fact("current_coverage", "none"), fact("pain", "daughters would have to split the funeral on credit cards"), fact("aligned", "yes"),
];
const toHealth = [...toDiscovery, ...discoveryFacts, stage("coverage"), fact("face_amount", "10000"), stage("health")];
const toQuoteStage = [...toHealth, stage("case_recap"), fact("case_confirmed", "yes"), fact("tier", "Level"), stage("quote")];
const options = [{ carrier: "Sample Carrier", product: "Sample Level Whole Life", face: 10000, monthly: 43.03 }];
const toPriceStage = [...toQuoteStage, { type: "quote", tier: "Level", options }, stage("price")];

test("coverage is blocked until discovery has found who they protect and the pain", () => {
  const s = play([...toDiscovery, fact("marital_status", "single")]);
  const why = validate(s, { type: "stage", to: "coverage", at: at() });
  assert.match(why, /Protecting/);
  assert.match(why, /Pain/);
  assert.match(why, /Current coverage/);
});

test("quote is blocked until the prospect confirms the needs recap", () => {
  const s = play([...toHealth, stage("case_recap"), fact("tier", "Level")]);
  assert.match(validate(s, { type: "stage", to: "quote", at: at() }), /recap their reasons/);
  const confirmed = play([fact("case_confirmed", "yes")], s);
  assert.ok(confirmed.badges.includes("Case Built"));
  assert.equal(validate(confirmed, { type: "stage", to: "quote", at: at() }), null);
});
const unresolved = { type: "objection", kind: "price", resolved: false };

test("an illegal transition is rejected and leaves the state unchanged", () => {
  const s = initialState(started());
  const ev = { type: "stage", to: "price", at: at() };
  assert.match(validate(s, ev), /Can't go from dialing to price/);
  assert.equal(reduce(s, ev), s);
});

test("price is blocked until the quote has run", () => {
  const s = play(toQuoteStage);
  const ev = { type: "stage", to: "price", at: at() };
  assert.equal(validate(s, ev), "Can't present price yet: run the quote first");
  assert.equal(reduce(s, ev).stage, "quote");
  assert.equal(validate(play([{ type: "quote", tier: "Level", options }], s), ev), null);
});

test("quote is blocked until a tier is captured", () => {
  const s = play([...toHealth, stage("case_recap"), fact("case_confirmed", "yes")]);
  assert.match(validate(s, { type: "stage", to: "quote", at: at() }), /get_quote/);
});

test("objections before price cost no lives", () => {
  const s = play([...toQuoteStage, unresolved, unresolved, unresolved, unresolved, unresolved]);
  assert.equal(s.livesLeft, OBJECTION_LIMIT);
  assert.equal(s.unresolvedAfterPrice, 0);
  assert.equal(s.objections.filter((o) => !o.afterPrice).length, 5);
  assert.equal(s.stage, "quote");
});

test("an unresolved objection after price costs a life", () => {
  const s = play([...toPriceStage, stage("objection"), unresolved]);
  assert.equal(s.livesLeft, OBJECTION_LIMIT - 1);
  assert.equal(s.stage, "objection");
});

test("4 unresolved objections after price end the call as lost with crmStatus 420", () => {
  const s = play([...toPriceStage, stage("objection"), unresolved, unresolved, unresolved]);
  assert.equal(s.stage, "objection");
  const lost = play([unresolved], s);
  assert.equal(lost.stage, "lost");
  assert.equal(lost.outcome, "lost");
  assert.equal(lost.crmStatus, 420);
  assert.equal(lost.livesLeft, 0);
  assert.match(validate(lost, stage("price")), /already ended/);
});

test("handoff is blocked until every HANDOFF_REQUIRES fact is present", () => {
  const upToRecap = [...toPriceStage, stage("commit"), stage("application"), stage("recap")];
  let s = play(upToRecap);
  const ev = { type: "stage", to: "handoff", at: at() };
  for (const key of HANDOFF_REQUIRES) {
    assert.match(validate(s, ev), /Can't hand off yet/, `blocked while ${key} missing`);
    s = play([{ type: "fact", key, value: "x" }], s);
  }
  assert.equal(validate(s, ev), null);
  const won = reduce(s, ev);
  assert.equal(won.outcome, "won");
  assert.equal(won.crmStatus, 300);
});

test("a hangup mid-call sets outcome hangup, and later events are rejected except transcript", () => {
  const s = play([stage("intro"), { type: "call_ended", reason: "prospect hung up" }]);
  assert.equal(s.outcome, "hangup");
  assert.equal(s.stage, "hangup");
  assert.match(validate(s, { type: "fact", key: "state", value: "TX" }), /already ended/);
  assert.equal(validate(s, { type: "transcript", speaker: "bot", text: "hello?" }), null);
});

test("scoring and badges follow the rules", () => {
  const s = play([...toPriceStage, stage("objection"), { type: "objection", kind: "price", resolved: true }]);
  assert.deepEqual(s.badges, ["Disclosed", "Case Built", "Price Presented", "Objection Crusher"]);
  // intro..price (10 stages incl. case_recap) plus objection is 11 first visits
  assert.equal(s.score, 11 * 10 + 25 + 15);
});

test("transcript is capped at the last 50 entries", () => {
  const lines = Array.from({ length: 60 }, (_, i) => ({ type: "transcript", speaker: "bot", text: `line ${i}` }));
  const s = play(lines);
  assert.equal(s.transcript.length, 50);
  assert.equal(s.transcript[0].text, "line 10");
});

test("folding the same event log twice gives deep-equal state", () => {
  const log = [started(), ...[...toPriceStage, stage("objection"), unresolved, stage("price")].map((e) => ({ at: at(), ...e }))];
  const fold = () => log.slice(1).reduce(reduce, initialState(log[0]));
  assert.deepEqual(fold(), fold());
  assert.equal(fold().stage, "price");
});

function runSim(file) {
  const entries = JSON.parse(readFileSync(new URL(`../sim/${file}`, import.meta.url), "utf8"));
  let state;
  entries.forEach(({ event }, i) => {
    const ev = { callId: "sim", at: 1000 * (i + 1), ...event };
    if (!state) { state = initialState(ev); return; }
    const why = validate(state, ev);
    // After the reducer ends a call itself, trailing transcript and call_ended lines are the only legal events.
    assert.equal(why, null, `${file} entry ${i} rejected: ${why}`);
    state = reduce(state, ev);
  });
  return state;
}

test("fe-happy-path.json ends won with the handoff facts captured", () => {
  const s = runSim("fe-happy-path.json");
  assert.equal(s.outcome, "won");
  assert.equal(s.crmStatus, 300);
  assert.ok(s.badges.includes("Closed"));
});

test("fe-lost-after-objections.json ends lost by 4 unresolved objections", () => {
  const s = runSim("fe-lost-after-objections.json");
  assert.equal(s.outcome, "lost");
  assert.equal(s.unresolvedAfterPrice, OBJECTION_LIMIT);
  assert.equal(s.crmStatus, 420);
});

const raised = (kind) => ({ type: "objection", kind });

test("an open objection after price is overcome when the call moves forward", () => {
  const s = play([...toPriceStage, stage("objection"), raised("price_too_high"), stage("commit")]);
  assert.equal(s.livesLeft, OBJECTION_LIMIT);
  assert.equal(s.objections.at(-1).resolved, true);
  assert.ok(s.badges.includes("Objection Crusher"));
});

test("a new objection before any progress means the open one was not overcome", () => {
  const s = play([...toPriceStage, stage("objection"), raised("price_too_high"), raised("need_to_think")]);
  assert.equal(s.livesLeft, OBJECTION_LIMIT - 1);
  assert.deepEqual(s.objections.map((o) => o.resolved), [false, null]);
});

test("the live test call's pattern (3 objections, then commit) costs 2 lives and keeps the sale", () => {
  const s = play([...toPriceStage, stage("objection"), raised("price_too_high"), raised("price_too_high"), raised("need_to_think"), stage("commit")]);
  assert.equal(s.livesLeft, OBJECTION_LIMIT - 2);
  assert.equal(s.stage, "commit");
});

test("open objections that never get past the price end the call as lost", () => {
  const five = Array.from({ length: OBJECTION_LIMIT + 1 }, () => raised("price_too_high"));
  const s = play([...toPriceStage, stage("objection"), ...five]);
  assert.equal(s.stage, "lost");
  assert.equal(s.crmStatus, 420);
});
