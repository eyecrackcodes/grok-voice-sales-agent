import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { twilioSignature } from "../src/twilio-signature.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BASE = "https://bot.example";
const TOKEN = "test-auth-token";
const dir = mkdtempSync(join(tmpdir(), "inbound-route-"));
writeFileSync(join(dir, "leads.csv"), "id,first_name,last_name,phone,state,timezone,dnc\nlead-7,Zelda,Stone,+15555550111,Ohio,America/Chicago,false\n");

const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let child, port;
const start = async (env) => {
  port = await freePort();
  child = spawn(process.execPath, ["src/server.mjs"], { cwd: ROOT, env: {
    ...process.env, PORT: String(port), PUBLIC_BASE: BASE, TWILIO_AUTH_TOKEN: TOKEN, CALL_LOG_DIR: "off", CRM_DATA_DIR: dir,
    INBOUND_DATA_DIR: dir, INBOUND_ENABLED: "true", INBOUND_HOUR_START: "0", INBOUND_HOUR_END: "24", INBOUND_MATCH: "any",
    INBOUND_FALLBACK_NUMBER: "+15555550000", TWILIO_PHONE_NUMBER: "+15555550100", ...env } });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => String(d).includes("Mission Control") && resolve());
    child.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
};
const stop = () => new Promise((resolve) => { if (!child) return resolve(); child.once("exit", resolve); child.kill(); child = null; });

const post = (form, { sign = true, path = "/twilio/inbound" } = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...(sign ? { "x-twilio-signature": twilioSignature(`${BASE}${path}`, form, TOKEN) } : {}) },
  body: new URLSearchParams(form),
});

before(() => start({}));
after(stop);

test("an unsigned or wrongly signed inbound request is refused", async () => {
  assert.equal((await post({ From: "+15555550111", CallSid: "CA1" }, { sign: false })).status, 403);
  const res = await fetch(`http://127.0.0.1:${port}/twilio/inbound`, { method: "POST", headers: { "x-twilio-signature": "bogus" }, body: new URLSearchParams({ From: "+15555550111" }) });
  assert.equal(res.status, 403);
});

test("a signed call goes to the bot with the caller's lead id but never the looked-up name", async () => {
  const res = await post({ From: "+15555550111", CallSid: "CA2" });
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.ok(xml.includes(`<Stream url="wss://bot.example/twilio-stream">`));
  assert.ok(xml.includes(`<Parameter name="source" value="inbound"/>`));
  assert.ok(xml.includes(`<Parameter name="leadUid" value="lead-7"/>`));
  assert.ok(xml.includes(`<Parameter name="callerPhone" value="+15555550111"/>`));
  assert.ok(!/Zelda|Stone|firstName|lastName/.test(xml));
});

test("a second call while the bot is busy rings the fallback number with the caller's ID", async () => {
  const xml = await (await post({ From: "+15555550122", CallSid: "CA3" })).text();
  assert.equal(xml, `<Response><Dial timeout="25" callerId="+15555550122"><Number>+15555550000</Number></Dial></Response>`);
});

test("with TWILIO_SIGNATURE_CHECK=off an unsigned request is accepted", async () => {
  await stop();
  await start({ TWILIO_SIGNATURE_CHECK: "off" });
  const res = await post({ From: "+15555550133", CallSid: "CA4" }, { sign: false });
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes("<Stream"));
});
