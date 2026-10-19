import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTransfer } from "../src/transfer.mjs";

const OURS = "+15555550100";
const LEAD = "+15555550123";

test("an outbound call's stream carries no caller number, so a queue transfer shows our own number as caller ID", async () => {
  Object.assign(process.env, { CONSENT_CONFIRMED: "true", PUBLIC_BASE: "https://bot.example", TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "t", TWILIO_PHONE_NUMBER: OURS });
  const { placeCall } = await import("../src/dialer.mjs");
  const realFetch = globalThis.fetch;
  let twiml = "";
  globalThis.fetch = async (url, init) => {
    const body = String(url).includes("/stream-secret") ? { secret: "s" } : { sid: "CAtest" };
    if (String(url).includes("api.twilio.com")) twiml = new URLSearchParams(init.body).get("Twiml");
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await placeCall({ id: 1, first_name: "Pat", phone: LEAD });
  } finally { globalThis.fetch = realFetch; }
  const callerPhone = /name="callerPhone" value="([^"]*)"/.exec(twiml)?.[1] ?? "";
  assert.notEqual(callerPhone, LEAD);
  const dial = buildTransfer({ mode: "queue", agent: "+15555550199", ourNumber: OURS, callerPhone });
  assert.ok(dial.includes(`callerId="${OURS}"`));
  assert.ok(!dial.includes(LEAD));
});
