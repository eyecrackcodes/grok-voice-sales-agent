import { test } from "node:test";
import assert from "node:assert/strict";
import { transferTwiml, buildTransfer } from "../src/transfer.mjs";

const OURS = "+15555550100", AGENT = "+15555550111", CALLER = "+15555550122";

test("a person is dialed with our number as caller ID and hears a whisper first", () => {
  const xml = buildTransfer({ mode: "person", agent: AGENT, ourNumber: OURS, callerPhone: CALLER, whisperUrl: "https://bot.example/twiml/whisper?callId=a&secret=b" });
  assert.ok(xml.includes(`<Dial callerId="${OURS}"`));
  assert.ok(xml.includes(`<Number url="https://bot.example/twiml/whisper?callId=a&#38;secret=b">${AGENT}</Number>`));
});

test("a queue is dialed straight through with the caller's own number, and ours when it is unknown", () => {
  const xml = buildTransfer({ mode: "queue", agent: AGENT, ourNumber: OURS, callerPhone: CALLER, whisperUrl: "https://bot.example/w" });
  assert.ok(xml.includes(`<Dial callerId="${CALLER}" timeout="25" answerOnBridge="true"><Number>${AGENT}</Number></Dial>`));
  assert.ok(!xml.includes("whisper") && !xml.includes("url="));
  assert.ok(buildTransfer({ mode: "queue", agent: AGENT, ourNumber: OURS, callerPhone: "" }).includes(`callerId="${OURS}"`));
});

test("the no-answer message is generic and promises a call back", () => {
  const xml = transferTwiml({ agent: AGENT, callerId: OURS });
  assert.ok(xml.includes("I'm sorry, our licensed agent couldn't pick up this second. We'll call you right back."));
});

test("the transfer mode comes from config", () => {
  const args = { agent: AGENT, ourNumber: OURS, callerPhone: CALLER, whisperUrl: "https://x/w" };
  process.env.TRANSFER_MODE = "queue";
  assert.ok(!buildTransfer(args).includes("url="));
  process.env.TRANSFER_MODE = "person";
  assert.ok(buildTransfer(args).includes(`url="https://x/w"`));
  delete process.env.TRANSFER_MODE;
});
