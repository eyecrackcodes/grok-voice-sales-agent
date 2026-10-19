import { test } from "node:test";
import assert from "node:assert/strict";
import { SETTINGS, GROUPS } from "../src/settings-schema.mjs";
import { config } from "../src/config.mjs";

const TYPES = new Set(["secret", "text", "textarea", "number", "bool", "select", "phone", "phones", "url"]);

test("every setting has a unique key, a known group and type, and a default that fits its own rules", () => {
  const groups = new Set(GROUPS.map((g) => g.id));
  const seen = new Set();
  for (const s of SETTINGS) {
    assert.ok(!seen.has(s.key), `duplicate ${s.key}`);
    seen.add(s.key);
    assert.ok(groups.has(s.group), `${s.key} group ${s.group}`);
    assert.ok(TYPES.has(s.type), `${s.key} type ${s.type}`);
    assert.ok(s.label, `${s.key} label`);
    if (s.type === "select") assert.ok(s.options.some((o) => o.value === s.default) || s.default === undefined, `${s.key} default not an option`);
    if (s.type === "number" && s.default !== undefined) assert.ok(s.default >= (s.min ?? -Infinity) && s.default <= (s.max ?? Infinity), `${s.key} default out of range`);
    if (s.when) for (const k of Object.keys(s.when)) assert.ok(SETTINGS.some((o) => o.key === k), `${s.key} depends on unknown ${k}`);
  }
});

test("config reads settings live, falls back to the table's defaults, and a blank value means the default", () => {
  const before = process.env.BOT_NAME;
  try {
    delete process.env.BOT_NAME;
    assert.equal(config.botName, "Sarah");
    process.env.BOT_NAME = "Maria";
    assert.equal(config.botName, "Maria");
    process.env.BOT_NAME = "";
    assert.equal(config.botName, "Sarah");
    process.env.INBOUND_MAX_PER_DAY = "7";
    assert.equal(config.inbound.maxPerDay, 7);
    assert.equal(config.aiDisclosure, true, "AI disclosure is on unless someone turns it off");
    assert.equal(config.inbound.enabled, false, "inbound is off until someone turns it on");
  } finally {
    if (before === undefined) delete process.env.BOT_NAME; else process.env.BOT_NAME = before;
    delete process.env.INBOUND_MAX_PER_DAY;
  }
});

test(".env.example is generated from the settings table and is up to date", async () => {
  const { readFileSync } = await import("node:fs");
  const { renderEnvExample } = await import("../scripts/env-example.mjs");
  const onDisk = readFileSync(new URL("../.env.example", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(onDisk, renderEnvExample(), "run npm run env-example");
});

test("the Twilio signature check cannot be switched off from the Settings page", async () => {
  const { SETTINGS } = await import("../src/settings-schema.mjs");
  assert.ok(!SETTINGS.some((s) => s.key === "TWILIO_SIGNATURE_CHECK"));
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../.env.example", import.meta.url), "utf8"), /^TWILIO_SIGNATURE_CHECK=on$/m);
});
