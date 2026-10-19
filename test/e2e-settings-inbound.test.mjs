import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { twilioSignature } from "../src/twilio-signature.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SECRET = "xai-secretvalue-1234567890";
const AUTH_TOKEN = "authtoken-test-0123456789";
const PUBLIC = "https://bot.example.com";

const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let child, base, log = "";
const dir = mkdtempSync(join(tmpdir(), "e2e-settings-"));

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // Nothing from the developer's shell may pre-configure the server, so the install starts fresh.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(X_API_KEY|TWILIO_|PUBLIC_BASE|DASHBOARD_TOKEN|INBOUND_|DIAL_ALLOWLIST|AGENT_TRANSFER|COMPANY_NAME)/.test(k)));
  child = spawn(process.execPath, ["src/server.mjs"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, PORT: String(port), SETTINGS_FILE: join(dir, "settings.json"), INBOUND_DATA_DIR: dir, CRM_DATA_DIR: dir, CALL_LOG_DIR: "off" } });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  await new Promise((resolve, reject) => {
    child.on("exit", (code) => reject(new Error(`server exited ${code}\n${log}`)));
    const poll = async () => { try { await fetch(`${base}/healthz`); resolve(); } catch { setTimeout(poll, 100); } };
    poll();
  });
});

after(() => new Promise((resolve) => {
  if (!child || child.exitCode !== null) return resolve();
  child.once("exit", resolve);
  child.kill();
}));

const json = (path, init) => fetch(base + path, init).then((r) => r.json());

test("a fresh install sends / to the Settings page and the checklist is not ready", async () => {
  const res = await fetch(`${base}/`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /\/settings/);
  assert.equal((await json("/api/settings")).checklist.ready, false);
});

test("saving the required settings makes the checklist ready, normalizes phones and never returns the secret", async () => {
  const put = await fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ values: {
    X_API_KEY: SECRET, TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000", TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    TWILIO_PHONE_NUMBER: "(555) 555-0100", PUBLIC_BASE: PUBLIC, DIAL_ALLOWLIST: "555-555-0123",
    AGENT_TRANSFER_NUMBER: "+15555550124", COMPANY_NAME: "Maple Final Expense", INBOUND_ENABLED: "true", INBOUND_HOUR_START: "0", INBOUND_HOUR_END: "24" } }) });
  const body = await put.text();
  assert.equal(put.status, 200, body);
  assert.ok(!body.includes(SECRET), "the saved secret must not come back");
  const saved = JSON.parse(body);
  assert.equal(saved.checklist.ready, true, saved.checklist.items.filter((i) => !i.done).map((i) => i.id).join(","));
  assert.equal(saved.settings.find((s) => s.key === "TWILIO_PHONE_NUMBER").value, "+15555550100");
});

test("after setup / opens Mission Control instead of Settings", async () => {
  const res = await fetch(`${base}/`, { redirect: "manual" });
  assert.ok(!(res.status === 302 && /settings/.test(res.headers.get("location") ?? "")));
});

test("a Twilio-signed inbound call gets stream TwiML built from settings saved moments earlier", async () => {
  const params = { CallSid: `CA${"1".repeat(32)}`, From: "+15555550177", To: "+15555550100" };
  const res = await fetch(`${base}/twilio/inbound`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(`${PUBLIC}/twilio/inbound`, params, AUTH_TOKEN) },
    body: new URLSearchParams(params) });
  const xml = await res.text();
  assert.equal(res.status, 200, xml);
  assert.match(xml, /<Connect><Stream url="wss:\/\/bot\.example\.com\/twilio-stream">/);
  assert.match(xml, /name="source" value="inbound"/);
});

test("an unsigned inbound call is refused", async () => {
  const res = await fetch(`${base}/twilio/inbound`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ CallSid: `CA${"2".repeat(32)}`, From: "+15555550177", To: "+15555550100" }) });
  assert.equal(res.status, 403);
});

test("Mission Control links to Settings, and the server log never printed the secret", async () => {
  assert.match(await (await fetch(`${base}/v2`)).text(), /href="\/settings"/);
  assert.ok(!log.includes(SECRET));
});
