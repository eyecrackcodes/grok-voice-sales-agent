import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "inbound-"));
process.env.INBOUND_DATA_DIR = dir;
process.env.TWILIO_PHONE_NUMBER = "+15555550100";
Object.assign(process.env, { INBOUND_ENABLED: "true", INBOUND_HOUR_START: "9", INBOUND_HOUR_END: "19", INBOUND_TZ: "America/Chicago", INBOUND_MAX_PER_DAY: "3", INBOUND_MAX_ACTIVE: "1" });
const inbound = await import("../src/inbound.mjs");
const { decide, route, claim, release, lookupCaller, botTwiml, fallbackTwiml } = inbound;

const open = { enabled: true, maxActive: 1, maxPerDay: 3, hours: [9, 19], activeCount: 0, todayCount: 0, hour: 12 };

test("the bot takes a call only when enabled, in hours, free, and under the daily cap", () => {
  assert.deepEqual(decide(open), { to: "bot" });
  assert.equal(decide({ ...open, enabled: false }).to, "fallback");
  assert.equal(decide({ ...open, hour: 8 }).to, "fallback");
  assert.equal(decide({ ...open, hour: 19 }).to, "fallback");
  assert.equal(decide({ ...open, hour: 9 }).to, "bot");
  assert.equal(decide({ ...open, activeCount: 1 }).to, "fallback");
  assert.equal(decide({ ...open, todayCount: 3 }).to, "fallback");
  assert.equal(decide({ ...open, todayCount: 2 }).to, "bot");
  assert.equal(decide({ ...open, looped: true }).to, "fallback");
});

// 2026-10-20 is a Tuesday; 17:00Z is noon in Chicago (CDT), 12:00Z is 7am.
const noon = new Date("2026-10-20T17:00:00Z");

test("route reads hours in the configured time zone, and our own number is a loop", () => {
  assert.equal(route("+15555550111", noon).to, "bot");
  assert.match(route("+15555550111", new Date("2026-10-20T12:00:00Z")).reason, /outside bot hours 9:00-19:00/);
  assert.match(route("+15555550100", noon).reason, /just with the bot/);
  assert.match(route("(555) 555-0100", noon).reason, /just with the bot/);
});

test("a claimed call holds the line until released, and the caller is a loop for 15 minutes", () => {
  claim("in-1", "+15555550111", noon);
  assert.match(route("+15555550122", noon).reason, /bot busy/);
  release("in-1");
  assert.equal(route("+15555550122", noon).to, "bot");
  assert.match(route("+15555550111", noon).reason, /just with the bot/);
  assert.equal(route("+15555550111", new Date(noon.getTime() + 16 * 60000)).to, "bot");
});

test("a claim that never connects its stream stops holding the line after the longest call", () => {
  claim("in-stale", "+15555550133", noon);
  assert.match(route("+15555550144", noon).reason, /bot busy/);
  assert.equal(route("+15555550144", new Date(noon.getTime() + 26 * 60000)).to, "bot");
  release("in-stale");
});

test("the daily count is persisted, survives a restart, and resets the next day", async () => {
  release("in-1");
  claim("in-2", "+15555550155", noon);
  release("in-2");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "inbound.json"), "utf8")).days, { "2026-10-20": 3 });
  const restarted = await import("../src/inbound.mjs?restart");
  assert.match(restarted.route("+15555550166", noon).reason, /daily bot cap reached \(3\/3\)/);
  assert.equal(restarted.route("+15555550166", new Date("2026-10-21T17:00:00Z")).to, "bot");
});

test("caller lookup honors the match setting", async () => {
  const calls = [];
  const adapter = { findByPhone: async (phone, opts) => { calls.push([phone, opts]); return { id: "lead-1" }; } };
  process.env.INBOUND_MATCH = "any";
  assert.deepEqual(await lookupCaller("+15555550111", { adapter }), { id: "lead-1" });
  process.env.INBOUND_MATCH = "recent";
  await lookupCaller("+15555550111", { adapter });
  process.env.INBOUND_MATCH = "off";
  assert.equal(await lookupCaller("+15555550111", { adapter }), null);
  assert.deepEqual(calls, [["5555550111", {}], ["5555550111", { recentMinutes: 30 }]]);
  process.env.INBOUND_MATCH = "any";
  assert.equal(await lookupCaller("anonymous", { adapter }), null, "no usable number, no lookup");
  assert.equal(calls.length, 2);
  assert.equal(await lookupCaller("+15555550111", { adapter: { findByPhone: async () => { throw new Error("crm down"); } } }), null);
  delete process.env.INBOUND_MATCH;
});

test("bot TwiML streams to the secure socket with escaped parameters and optional accept tones", () => {
  const xml = botTwiml({ base: "https://bot.example", params: { callId: "in-1", note: `O'Neil & "Co"` }, acceptDigits: "" });
  assert.ok(xml.includes(`<Stream url="wss://bot.example/twilio-stream">`));
  assert.ok(xml.includes(`value="O&#39;Neil &#38; &#34;Co&#34;"`));
  assert.ok(!xml.includes("<Play"));
  assert.ok(botTwiml({ base: "https://bot.example", params: {}, acceptDigits: "w1" }).startsWith(`<Response><Play digits="w1"/><Connect>`));
  process.env.INBOUND_ACCEPT_DIGITS = "w2";
  assert.ok(botTwiml({ base: "https://bot.example", params: {} }).includes(`<Play digits="w2"/>`));
  delete process.env.INBOUND_ACCEPT_DIGITS;
});

test("the fallback rings the configured number with the caller's ID, and says so plainly when none is set", () => {
  assert.equal(fallbackTwiml({ number: "+15555550000", callerId: "+15555550111" }),
    `<Response><Dial timeout="25" callerId="+15555550111"><Number>+15555550000</Number></Dial></Response>`);
  assert.ok(fallbackTwiml({ number: "" }).includes("<Say>"));
  process.env.INBOUND_FALLBACK_NUMBER = "+15555550177";
  assert.ok(fallbackTwiml({ callerId: "+15555550111" }).includes("<Number>+15555550177</Number>"));
  delete process.env.INBOUND_FALLBACK_NUMBER;
});

test("a claim whose stream never starts is released after 45 seconds, a started one holds until the longest call", () => {
  const at = (s) => new Date(noon.getTime() + s * 1000);
  claim("in-unstarted", "+15555550177", noon);
  claim("in-started", "+15555550178", noon);
  inbound.markStarted("in-started");
  assert.match(route("+15555550199", at(44)).reason, /bot busy \(2\/\d+ active\)/);
  assert.match(route("+15555550199", at(46)).reason, /bot busy \(1\/\d+ active\)/);
  assert.match(route("+15555550199", at(20 * 60)).reason, /bot busy \(1\/\d+ active\)/);
  release("in-started");
  release("in-unstarted");
});

test("a caller with no caller ID is never recorded for the loop guard or treated as a loop", () => {
  for (const anon of ["", "anonymous", undefined]) {
    claim(`in-anon-${anon}`, anon, noon);
    release(`in-anon-${anon}`);
    assert.doesNotMatch(route(anon, noon).reason ?? "", /just with the bot/, String(anon));
    assert.doesNotMatch(route("", noon).reason ?? "", /just with the bot/, "an earlier anonymous call must not make the next one a loop");
  }
});
