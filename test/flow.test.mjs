import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeStage, canTransition, FACTS } from "../src/flow.mjs";

test("a caller can ask for a person from any live stage, but not once the call is over", () => {
  for (const from of ["intro", "discovery", "health", "price", "objection", "commit"]) assert.equal(canTransition(from, "transferred"), true, from);
  assert.equal(canTransition("lost", "transferred"), false);
  assert.equal(canTransition("handoff", "transferred"), false);
});

test("a one-step skip is bridged through the stage between", () => {
  assert.equal(bridgeStage("case_recap", "price"), "quote");
  assert.equal(bridgeStage("quote", "commit"), "price");
  assert.equal(bridgeStage("application", "handoff"), "recap");
});

test("no bridge for a two-step gap, a legal direct move, or a path through objection", () => {
  assert.equal(bridgeStage("health", "price"), null);
  assert.equal(bridgeStage("case_recap", "quote"), null);
  assert.equal(bridgeStage("case_recap", "commit"), null);
  assert.equal(bridgeStage("handoff", "price"), null);
});

test("the draft date is set by the server, never by the bot's save_facts", () => {
  assert.equal(FACTS.draft_date.serverOnly, true);
});
