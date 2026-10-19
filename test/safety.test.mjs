import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DIAL_ALLOWLIST = "+15555550123, +15555550124";
delete process.env.CONSENT_CONFIRMED;
const { checkDial, toE164, warnConsentOnce, config } = await import("../src/config.mjs");

test("demo mode refuses numbers off the allowlist, logs why, and allows listed ones", () => {
  const logs = [];
  assert.equal(checkDial("+15555550123", { log: (m) => logs.push(m) }).ok, true);
  assert.equal(logs.length, 0);
  const refused = checkDial("+15555550199", { log: (m) => logs.push(m) });
  assert.equal(refused.ok, false);
  assert.match(logs[0], /REFUSED/);
  assert.match(logs[0], /DIAL_ALLOWLIST/);
  assert.doesNotMatch(logs[0], /5555550199/, "the full number is not logged");
});

test("with CONSENT_CONFIRMED the allowlist is off and the responsibility warning is logged exactly once", () => {
  process.env.CONSENT_CONFIRMED = "true";
  const warnings = [];
  const original = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    assert.equal(checkDial("+15555550199").ok, true);
    assert.equal(checkDial("+15555550198").ok, true);
    warnConsentOnce();
  } finally {
    console.warn = original;
    delete process.env.CONSENT_CONFIRMED;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /TCPA/);
});

test("phone numbers normalize to US E.164 or null", () => {
  assert.equal(toE164("(555) 555-0123"), "+15555550123");
  assert.equal(toE164("1-555-555-0123"), "+15555550123");
  assert.equal(toE164("+15555550123"), "+15555550123");
  assert.equal(toE164("12345"), null);
});
