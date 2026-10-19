import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsStore } from "../src/settings.mjs";
import { createSettingsRoutes } from "../src/settings-routes.mjs";
import { authorize } from "../src/dashboard-auth.mjs";

const XAI_KEY = "xai-PLAINTEXT-never-shown-9f3k";
const TWILIO_TOKEN = "twilio-token-PLAINTEXT-77aa";
const NEW_PASSWORD = "brand-new-password-4242";

// Mirrors server.mjs: authorize() first, then the settings routes.
async function start({ env = {}, fetch, publicBase } = {}) {
  const store = createSettingsStore({ file: join(mkdtempSync(join(tmpdir(), "gvsa-api-")), "settings.json"), env });
  const handle = createSettingsRoutes({ store, fetch, publicBase, loadCrm: async () => ({ listQueue: async () => [{ id: 1 }, { id: 2 }] }) });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const access = authorize(req, url, store.get("DASHBOARD_TOKEN"));
    if (!access.ok) { res.writeHead(access.status); return res.end(); }
    if (!(await handle(req, res, url))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = "GET", body, headers = {} } = {}) => {
    const res = await globalThis.fetch(base + path, { method, redirect: "manual", headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const isJson = res.headers.get("content-type")?.includes("json");
    return { status: res.status, text, json: isJson ? JSON.parse(text) : null, headers: res.headers };
  };
  return { store, env, call, close: () => new Promise((r) => server.close(r)) };
}

const row = (payload, key) => payload.settings.find((s) => s.key === key);

test("GET lists every schema row with its value or mask, its source, and the setup checklist", async (t) => {
  const app = await start({ env: { COMPANY_NAME: "Locked Co" } });
  t.after(app.close);
  const { status, json } = await app.call("/api/settings");
  assert.equal(status, 200);
  assert.ok(json.groups.length > 0);
  assert.equal(row(json, "BOT_NAME").value, "Sarah");
  assert.equal(row(json, "BOT_NAME").source, "default");
  assert.equal(row(json, "COMPANY_NAME").source, "environment");
  assert.equal(row(json, "COMPANY_NAME").locked, true);
  assert.equal(row(json, "CRM_PROVIDER").restart, true);
  assert.equal("value" in row(json, "X_API_KEY"), false);
  assert.equal(row(json, "X_API_KEY").set, false);
  assert.equal(json.checklist.ready, false);
  assert.deepEqual(json.checklist.items.map((i) => i.id), ["xai", "twilio", "number", "public", "test-number", "transfer"]);
  assert.ok(json.checklist.items.every((i) => i.label && i.hint && i.done === false));
});

test("secret plaintext never appears in a GET or PUT response or the log; only the last 4 characters do", async (t) => {
  const app = await start();
  t.after(app.close);
  const logged = [];
  const { log, error, warn } = console;
  console.log = console.error = console.warn = (...a) => logged.push(a.join(" "));
  try {
    const put = await app.call("/api/settings", { method: "PUT", body: { values: { X_API_KEY: XAI_KEY, TWILIO_AUTH_TOKEN: TWILIO_TOKEN } } });
    const get = await app.call("/api/settings");
    for (const r of [put, get]) {
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes(XAI_KEY) && !r.text.includes(TWILIO_TOKEN), "plaintext in response");
      assert.ok(!r.text.includes("never-shown"), "a fragment of the plaintext in response");
      assert.equal(row(r.json, "X_API_KEY").last4, "9f3k");
      assert.equal(row(r.json, "X_API_KEY").set, true);
      assert.equal(row(r.json, "X_API_KEY").source, "settings");
    }
    assert.equal(app.env.X_API_KEY, XAI_KEY, "the real value reaches the environment");
  } finally { Object.assign(console, { log, error, warn }); }
  assert.ok(logged.length > 0);
  assert.ok(logged.every((l) => !l.includes(XAI_KEY) && !l.includes(TWILIO_TOKEN)), logged.join("\n"));
});

test("a secret sent as blank keeps its value, and the clear list removes it", async (t) => {
  const app = await start();
  t.after(app.close);
  await app.call("/api/settings", { method: "PUT", body: { values: { X_API_KEY: XAI_KEY } } });
  await app.call("/api/settings", { method: "PUT", body: { values: { X_API_KEY: "" } } });
  assert.equal(app.env.X_API_KEY, XAI_KEY);
  const cleared = await app.call("/api/settings", { method: "PUT", body: { clear: ["X_API_KEY"] } });
  assert.equal(row(cleared.json, "X_API_KEY").set, false);
  assert.equal(app.env.X_API_KEY, undefined);
});

test("validation normalizes each type and returns a message per bad field without saving anything", async (t) => {
  const app = await start();
  t.after(app.close);
  const ok = await app.call("/api/settings", { method: "PUT", body: { values: {
    TWILIO_PHONE_NUMBER: "(512) 555-0100", DIAL_ALLOWLIST: "512-555-0101, +1 512 555 0102", PUBLIC_BASE: "https://bot.example.com/",
    MAX_CALL_MINUTES: 30, VOICE: "ara", AI_DISCLOSURE: false, COMPANY_NAME: "  Acme Life  ", BOT_NAME: "",
  } } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(
    ["TWILIO_PHONE_NUMBER", "DIAL_ALLOWLIST", "PUBLIC_BASE", "MAX_CALL_MINUTES", "VOICE", "AI_DISCLOSURE", "COMPANY_NAME"].map((k) => app.env[k]),
    ["+15125550100", "+15125550101,+15125550102", "https://bot.example.com", "30", "ara", "false", "Acme Life"]);
  assert.equal(row(ok.json, "BOT_NAME").source, "default", "a blank non-secret goes back to its default");

  const bad = await app.call("/api/settings", { method: "PUT", body: { values: {
    TWILIO_PHONE_NUMBER: "555-01", DIAL_ALLOWLIST: "5125550101, nope", PUBLIC_BASE: "http://bot.example.com", MAX_CALL_MINUTES: 61,
    VOICE: "robot", AI_DISCLOSURE: "yes", COMPANY_NAME: "x".repeat(501), SCRIPT_EXTRA: "y".repeat(8001), DASHBOARD_TOKEN: "short",
    INBOUND_MAX_PER_DAY: "lots", BOT_NAME: "Untouched",
  } } });
  assert.equal(bad.status, 422);
  assert.deepEqual(Object.keys(bad.json.errors).sort(), ["AI_DISCLOSURE", "COMPANY_NAME", "DASHBOARD_TOKEN", "DIAL_ALLOWLIST", "INBOUND_MAX_PER_DAY",
    "MAX_CALL_MINUTES", "PUBLIC_BASE", "SCRIPT_EXTRA", "TWILIO_PHONE_NUMBER", "VOICE"]);
  assert.ok(Object.values(bad.json.errors).every((m) => typeof m === "string" && m.length > 5));
  assert.equal(app.env.BOT_NAME, undefined, "nothing is saved when any field is invalid");
  assert.equal(app.env.TWILIO_PHONE_NUMBER, "+15125550100");
});

test("unknown, read-only and locked keys are refused, in values and in the clear list", async (t) => {
  const app = await start({ env: { COMPANY_NAME: "From Docker" } });
  t.after(app.close);
  const r = await app.call("/api/settings", { method: "PUT", body: { values: { NOT_A_SETTING: "x", VAULT_KEY: "abc", COMPANY_NAME: "Mine" }, clear: ["COMPANY_NAME", "PATH"] } });
  assert.equal(r.status, 422);
  assert.deepEqual(Object.keys(r.json.errors).sort(), ["COMPANY_NAME", "NOT_A_SETTING", "PATH", "VAULT_KEY"]);
  assert.equal(app.env.COMPANY_NAME, "From Docker");
  assert.equal(app.env.NOT_A_SETTING, undefined);
  assert.equal((await app.call("/api/settings", { method: "PUT", body: { values: [] } })).status, 422);
  assert.equal((await app.call("/api/settings", { method: "PUT", body: "not an object" })).status, 200, "a body with no values changes nothing");
});

test("changing DASHBOARD_TOKEN sets the cookie for the new value, and the old token stops working", async (t) => {
  const app = await start({ env: {} });
  t.after(app.close);
  const first = await app.call("/api/settings", { method: "PUT", body: { values: { DASHBOARD_TOKEN: "first-password-1234" } } });
  assert.match(first.headers.get("set-cookie"), /^dash_token=first-password-1234; HttpOnly; SameSite=Strict; Path=\//);
  assert.equal((await app.call("/api/settings")).status, 401, "the token is enforced at once");
  const auth = { authorization: "Bearer first-password-1234" };
  const second = await app.call("/api/settings", { method: "PUT", headers: auth, body: { values: { DASHBOARD_TOKEN: NEW_PASSWORD } } });
  assert.equal(second.status, 200);
  const cookie = second.headers.get("set-cookie").split(";")[0];
  assert.equal(cookie, `dash_token=${NEW_PASSWORD}`);
  assert.ok(!second.text.includes(NEW_PASSWORD), "the new password is not in the body");
  assert.equal((await app.call("/api/settings", { headers: { cookie } })).status, 200);
  assert.equal((await app.call("/api/settings", { headers: auth })).status, 401);
  const unchanged = await app.call("/api/settings", { method: "PUT", headers: { cookie }, body: { values: { BOT_NAME: "Maria" } } });
  assert.equal(unchanged.headers.get("set-cookie"), null, "no cookie when the token did not change");
});

test("the routes enforce DASHBOARD_TOKEN: 401 without it, 200 with it", async (t) => {
  const app = await start({ env: { DASHBOARD_TOKEN: "locked-token-123456" } });
  t.after(app.close);
  assert.equal((await app.call("/api/settings")).status, 401);
  assert.equal((await app.call("/api/settings", { method: "PUT", body: { values: { BOT_NAME: "x" } } })).status, 401);
  assert.equal((await app.call("/api/settings/test/xai", { method: "POST" })).status, 401);
  assert.equal((await app.call("/api/settings", { headers: { authorization: "Bearer locked-token-123456" } })).status, 200);
});

test("/ and /v2 send a new user to /settings until the checklist is done; skip-setup still opens Mission Control", async (t) => {
  const app = await start({ env: {}, publicBase: () => "https://bot.example.com" });
  t.after(app.close);
  for (const p of ["/", "/v2"]) {
    const r = await app.call(p);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/settings");
  }
  assert.equal((await app.call("/v2?skip-setup=1")).status, 404, "falls through to the dashboard route");
  const page = await app.call("/settings");
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>Settings<\/title>/);
  await app.call("/api/settings", { method: "PUT", body: { values: {
    X_API_KEY: XAI_KEY, TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: TWILIO_TOKEN, TWILIO_PHONE_NUMBER: "5125550100",
    DIAL_ALLOWLIST: "5125550101", AGENT_TRANSFER_NUMBER: "5125550102" } } });
  const done = await app.call("/api/settings");
  assert.equal(done.json.checklist.ready, true);
  assert.equal((await app.call("/v2")).status, 404, "no redirect once ready");
});

function stubFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, reply] of routes) {
      if (String(url).includes(match) && (!reply.method || reply.method === (init.method ?? "GET"))) {
        if (reply.throw) throw reply.throw;
        return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
      }
    }
    return new Response("{}", { status: 404 });
  };
  return Object.assign(fn, { calls });
}

test("xai test sends the key to the models endpoint and explains a rejection in plain words", async (t) => {
  const fetch = stubFetch([["api.x.ai/v1/models", { status: 200, body: { data: [] } }]]);
  const app = await start({ env: { X_API_KEY: XAI_KEY }, fetch });
  t.after(app.close);
  const r = await app.call("/api/settings/test/xai", { method: "POST" });
  assert.deepEqual(r.json, { ok: true, message: "xAI accepted your key." });
  assert.equal(fetch.calls[0].init.headers.Authorization, `Bearer ${XAI_KEY}`);

  const denied = await start({ env: { X_API_KEY: XAI_KEY }, fetch: stubFetch([["api.x.ai", { status: 401 }]]) });
  t.after(denied.close);
  const d = await denied.call("/api/settings/test/xai", { method: "POST" });
  assert.equal(d.json.ok, false);
  assert.match(d.json.message, /rejected this key/);
  assert.ok(!d.text.includes(XAI_KEY));

  const missing = await start({ env: {}, fetch: stubFetch([]) });
  t.after(missing.close);
  assert.deepEqual((await missing.call("/api/settings/test/xai", { method: "POST" })).json, { ok: false, message: "Add your xAI API key first." });
  assert.equal((await missing.call("/api/settings/test/nope", { method: "POST" })).status, 404);
});

const TWILIO_ENV = { TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: TWILIO_TOKEN, TWILIO_PHONE_NUMBER: "+15125550100" };

test("twilio test checks the account, then that the phone number belongs to it", async (t) => {
  const owned = stubFetch([
    ["/Accounts/AC123.json", { body: { friendly_name: "Mine" } }],
    ["/IncomingPhoneNumbers.json?PhoneNumber=%2B15125550100", { body: { incoming_phone_numbers: [{ sid: "PN1" }] } }],
  ]);
  const app = await start({ env: TWILIO_ENV, fetch: owned });
  t.after(app.close);
  const r = await app.call("/api/settings/test/twilio", { method: "POST" });
  assert.equal(r.json.ok, true, r.text);
  assert.equal(owned.calls[0].init.headers.Authorization, `Basic ${Buffer.from(`AC123:${TWILIO_TOKEN}`).toString("base64")}`);

  const notOwned = await start({ env: TWILIO_ENV, fetch: stubFetch([
    ["/Accounts/AC123.json", { body: {} }], ["/IncomingPhoneNumbers.json", { body: { incoming_phone_numbers: [] } }]]) });
  t.after(notOwned.close);
  const n = await notOwned.call("/api/settings/test/twilio", { method: "POST" });
  assert.equal(n.json.ok, false);
  assert.match(n.json.message, /\+15125550100 is not one of its phone numbers/);

  const badLogin = await start({ env: TWILIO_ENV, fetch: stubFetch([["/Accounts/AC123.json", { status: 401 }]]) });
  t.after(badLogin.close);
  assert.match((await badLogin.call("/api/settings/test/twilio", { method: "POST" })).json.message, /rejected the Account SID and Auth Token/);
});

test("crm test reports the queue size; public test fetches PUBLIC_BASE/healthz and reports a network failure plainly", async (t) => {
  const healthy = stubFetch([["https://bot.example.com/healthz", { body: { ok: true } }]]);
  const app = await start({ env: {}, fetch: healthy, publicBase: () => "https://bot.example.com" });
  t.after(app.close);
  assert.deepEqual((await app.call("/api/settings/test/crm", { method: "POST" })).json, { ok: true, message: "Connected. 2 leads are ready to call." });
  const pub = await app.call("/api/settings/test/public", { method: "POST" });
  assert.deepEqual(pub.json, { ok: true, message: "Twilio can reach this server at https://bot.example.com." });
  assert.equal(healthy.calls[0].url, "https://bot.example.com/healthz");

  const down = await start({ env: {}, fetch: stubFetch([["healthz", { throw: new TypeError("fetch failed") }]]), publicBase: () => "https://bot.example.com" });
  t.after(down.close);
  assert.deepEqual((await down.call("/api/settings/test/public", { method: "POST" })).json,
    { ok: false, message: "Could not reach https://bot.example.com: fetch failed." });
});

test("point-number sets the number's VoiceUrl to /twilio/inbound and the fallback to a twimlet forward", async (t) => {
  const twilio = stubFetch([
    ["/IncomingPhoneNumbers.json?PhoneNumber=", { body: { incoming_phone_numbers: [{ sid: "PN42" }] } }],
    ["/IncomingPhoneNumbers/PN42.json", { method: "POST", body: { sid: "PN42" } }],
  ]);
  const app = await start({ env: { ...TWILIO_ENV, INBOUND_FALLBACK_NUMBER: "+15125550199" }, fetch: twilio, publicBase: () => "https://bot.example.com" });
  t.after(app.close);
  const r = await app.call("/api/twilio/point-number", { method: "POST" });
  assert.equal(r.json.ok, true, r.text);
  const expected = { VoiceUrl: "https://bot.example.com/twilio/inbound", VoiceMethod: "POST",
    VoiceFallbackUrl: "https://twimlets.com/forward?PhoneNumber=%2B15125550199" };
  assert.deepEqual(r.json.set, expected);
  const update = twilio.calls.find((c) => c.init.method === "POST");
  assert.match(update.url, /\/Accounts\/AC123\/IncomingPhoneNumbers\/PN42\.json$/);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(update.init.body.toString())), expected);

  const noFallback = stubFetch([
    ["/IncomingPhoneNumbers.json?PhoneNumber=", { body: { incoming_phone_numbers: [{ sid: "PN42" }] } }],
    ["/IncomingPhoneNumbers/PN42.json", { method: "POST", body: {} }]]);
  const plain = await start({ env: TWILIO_ENV, fetch: noFallback, publicBase: () => "https://bot.example.com" });
  t.after(plain.close);
  assert.equal((await plain.call("/api/twilio/point-number", { method: "POST" })).json.set.VoiceFallbackUrl, "");
});

// Stubs placeCall so no test reaches Twilio or xAI.
async function startCalls({ env = {}, placeCall }) {
  const calls = [];
  const stub = placeCall ?? (async (lead, opts) => { calls.push({ lead, opts }); return { callSid: "CA1", callId: "call-test", last4: lead.phone.slice(-4) }; });
  const store = createSettingsStore({ file: join(mkdtempSync(join(tmpdir(), "gvsa-api-")), "settings.json"), env });
  const handle = createSettingsRoutes({ store, placeCall: async (...a) => { if (!placeCall) return stub(...a); calls.push(a); return stub(...a); } });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const access = authorize(req, url, store.get("DASHBOARD_TOKEN"));
    if (!access.ok) { res.writeHead(access.status); return res.end(); }
    if (!(await handle(req, res, url))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const post = async (body, headers = {}) => {
    const res = await globalThis.fetch(`http://127.0.0.1:${server.address().port}/api/test-call`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { calls, post, close: () => new Promise((r) => server.close(r)) };
}

test("test call refuses a number outside DIAL_ALLOWLIST in demo mode and never calls placeCall", async (t) => {
  const app = await startCalls({ env: { DIAL_ALLOWLIST: "+15551230001" } });
  t.after(app.close);
  const { json } = await app.post({ phone: "555 123 9999", name: "Sam" });
  assert.equal(json.ok, false);
  assert.match(json.message, /not on your test list/);
  assert.equal(app.calls.length, 0);
});

test("test call passes a normalized number and the name to placeCall and returns the call id", async (t) => {
  const app = await startCalls({ env: { DIAL_ALLOWLIST: "+15551230001" } });
  t.after(app.close);
  const { json } = await app.post({ phone: "(555) 123-0001", name: "  Sam " });
  assert.deepEqual(json, { ok: true, callId: "call-test" });
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].lead.phone, "+15551230001");
  assert.equal(app.calls[0].lead.first_name, "Sam");
  assert.deepEqual(app.calls[0].opts, {}, "source is left to the dialer's configured default");
  const named = await app.post({ phone: "5551230001", source: "requested_info" });
  assert.equal(app.calls[1].lead.first_name, "there");
  assert.equal(app.calls[1].opts.source, "requested_info");
  assert.equal(named.json.ok, true);
});

test("test call returns the placeCall error as a plain message", async (t) => {
  const app = await startCalls({ env: { DIAL_ALLOWLIST: "+15551230001" },
    placeCall: async () => { throw new Error("No public URL: start the tunnel (data/tunnel.log) or set PUBLIC_BASE"); } });
  t.after(app.close);
  const { status, json } = await app.post({ phone: "+15551230001" });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: false, message: "No public URL: start the tunnel (data/tunnel.log) or set PUBLIC_BASE" });
});

test("test call requires the dashboard token when one is set", async (t) => {
  const app = await startCalls({ env: { DIAL_ALLOWLIST: "+15551230001", DASHBOARD_TOKEN: "locked-token-123456" } });
  t.after(app.close);
  assert.equal((await app.post({ phone: "+15551230001" })).status, 401);
  assert.equal(app.calls.length, 0);
  const ok = await app.post({ phone: "+15551230001" }, { authorization: "Bearer locked-token-123456" });
  assert.equal(ok.json.ok, true);
});
