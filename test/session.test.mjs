import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

process.env.CALL_LOG_DIR = "off";
process.env.X_API_KEY = "test-key";
process.env.VOICE_MODEL = "grok-test-model";
const { startSession } = await import("../src/session.mjs");
const { dispatch, getState } = await import("../src/hub.mjs");

let n = 0;
function open(hooks = {}) {
  const callId = `sess-${++n}`;
  const sent = [];
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send: (m) => sent.push(JSON.parse(m)), close() {}, terminate() {} });
  let url;
  const session = startSession({ callId, lead: {}, params: { firstName: "Pat" }, hooks: { log() {}, ...hooks },
    connect: (u) => { url = u; return socket; } });
  socket.emit("open");
  const tool = async (name, args = {}) => {
    const call_id = `c${sent.length}`;
    socket.emit("message", JSON.stringify({ type: "response.function_call_arguments.done", name, arguments: JSON.stringify(args), call_id }));
    await new Promise((r) => setImmediate(r));
    return JSON.parse(sent.find((m) => m.item?.call_id === call_id).item.output);
  };
  return { callId, tool, session, url: () => url };
}

const walk = (callId, ...events) => events.forEach((e) => assert.equal(dispatch({ callId, ...e }).ok, true, JSON.stringify(e)));
const toHealth = (callId) => walk(callId,
  ...["confirm", "agenda", "eligibility", "discovery"].map((to) => ({ type: "stage", to })),
  ...Object.entries({ marital_status: "single", protecting: "son", current_coverage: "none", pain: "son would pay", aligned: "yes" }).map(([key, value]) => ({ type: "fact", key, value })),
  { type: "stage", to: "coverage" }, { type: "fact", key: "face_amount", value: "10000" }, { type: "stage", to: "health" });

test("the voice model comes from config, not a constant", () => {
  const { url, session } = open();
  assert.match(url(), /model=grok-test-model$/);
  session.end("test");
});

test("a person can be requested from discovery, and the transfer is requested", async () => {
  let requested = 0;
  const { callId, tool, session } = open({ onTransferRequested: () => requested++ });
  walk(callId, ...["confirm", "agenda", "eligibility", "discovery"].map((to) => ({ type: "stage", to })));
  const r = await tool("transfer_to_agent", { reason: "asked for a person" });
  assert.equal(r.ok, true);
  assert.equal(getState(callId).outcome, "transferred");
  assert.equal(requested, 1);
  assert.equal(session.transferring, true);
  session.end("test");
});

test("set_stage walks one skipped step, reports each stage through onStage, and says where it stopped", async () => {
  const seen = [];
  const { callId, tool, session } = open({ onStage: (s) => seen.push(s) });
  toHealth(callId);
  assert.equal((await tool("set_stage", { stage: "case_recap" })).ok, true);
  walk(callId, { type: "fact", key: "case_confirmed", value: "yes" }, { type: "fact", key: "tier", value: "LEVEL" });
  const stuck = await tool("set_stage", { stage: "price" });
  assert.equal(stuck.stage, "quote", "price needs a quote first, so the walk stops at quote");
  assert.match(stuck.note, /price not allowed yet/);
  walk(callId, { type: "quote", tier: "LEVEL", options: [{ face: 10000, monthly: 50 }] });
  assert.equal((await tool("set_stage", { stage: "price" })).stage, "price");
  assert.deepEqual(seen, ["case_recap", "quote", "price"]);
  assert.equal((await tool("set_stage", { stage: "handoff" })).ok, false, "a two-step gap is refused");
  session.end("test");
});

test("pick_draft_date posts the server's date, and the bot cannot set draft_date itself", async () => {
  const { callId, tool, session } = open();
  walk(callId, { type: "fact", key: "date_of_birth", value: "03/15/1950" });
  const r = await tool("pick_draft_date", {});
  assert.equal(r.ok, true);
  assert.match(r.basis, /born on the 15th/);
  assert.equal(getState(callId).facts.draft_date, r.draft_date);
  const forged = await tool("save_facts", { draft_date: "01/01/2030" });
  assert.equal(forged.ok, false);
  assert.equal(getState(callId).facts.draft_date, r.draft_date);
  session.end("test");
});

test("pick_draft_date with nothing to go on asks for the deposit day and posts nothing", async () => {
  const { callId, tool, session } = open();
  const r = await tool("pick_draft_date", {});
  assert.equal(r.ok, false);
  assert.equal(getState(callId).facts.draft_date, undefined);
  session.end("test");
});
