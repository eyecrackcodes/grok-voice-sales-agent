// The Settings page and its API. Mounted behind authorize() in server.mjs.
// Secret values never leave this module: responses carry only whether a secret is set
// and, for long ones, its last 4 characters.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GROUPS, SETTINGS } from "./settings-schema.mjs";
import { settings } from "./settings.mjs";
import { validateUpdate } from "./settings-validate.mjs";
import { sessionCookie } from "./dashboard-auth.mjs";
import { toE164 } from "./config.mjs";

const PAGE = fileURLToPath(new URL("../public/settings.html", import.meta.url));
const TIMEOUT_MS = 10_000;
const BODY_LIMIT = 256 * 1024;

const envPublicBase = () => {
  const base = process.env.PUBLIC_BASE;
  if (!base) throw new Error("No public address yet: set PUBLIC_BASE.");
  return base.replace(/\/+$/, "");
};

const CHECKS = [
  { id: "xai", label: "xAI API key", key: "X_API_KEY", hint: "Paste your key from console.x.ai under Connect your accounts.",
    done: (s) => s.isSet("X_API_KEY") },
  { id: "twilio", label: "Twilio account", key: "TWILIO_ACCOUNT_SID", hint: "Paste the Account SID and Auth Token from your Twilio console home page.",
    done: (s) => s.isSet("TWILIO_ACCOUNT_SID") && s.isSet("TWILIO_AUTH_TOKEN") },
  { id: "number", label: "Twilio phone number", key: "TWILIO_PHONE_NUMBER", hint: "Enter the Twilio number your calls come from.",
    done: (s) => s.isSet("TWILIO_PHONE_NUMBER") },
  { id: "public", label: "Public address", key: "PUBLIC_BASE", hint: "Enter the https address Twilio uses to reach this server.",
    done: (s, publicBase) => { try { return Boolean(publicBase()); } catch { return false; } } },
  { id: "test-number", label: "A number to test with", key: "DIAL_ALLOWLIST", hint: "Put your own cell under Outbound calling so the bot may call you.",
    done: (s) => s.isSet("DIAL_ALLOWLIST") || s.get("CONSENT_CONFIRMED") === "true" },
  { id: "transfer", label: "Transfer number", key: "AGENT_TRANSFER_NUMBER", hint: "Enter the phone or call queue that takes finished calls, under Calls and transfers.",
    done: (s) => s.isSet("AGENT_TRANSFER_NUMBER") },
];

export function checklist(store, publicBase) {
  const items = CHECKS.map(({ id, label, key, hint, done }) => ({ id, label, key, hint, done: done(store, publicBase) }));
  return { ready: items.every((i) => i.done), items };
}

export function settingsPayload(store, publicBase) {
  const rows = SETTINGS.map((row) => {
    const raw = store.get(row.key);
    const set = store.isSet(row.key);
    const base = { ...row, set, source: store.sourceOf(row.key), locked: store.isLocked(row.key), restart: Boolean(row.restart) };
    // Four characters of a short secret give away too much of it.
    if (row.type === "secret") return { ...base, last4: set && raw.length >= 12 ? raw.slice(-4) : null };
    return { ...base, value: set ? raw : row.default === undefined ? "" : String(row.default) };
  });
  return { groups: GROUPS, settings: rows, checklist: checklist(store, publicBase) };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > BODY_LIMIT) throw Object.assign(new Error("Request too large."), { status: 413 });
  }
  try { return JSON.parse(raw || "{}"); } catch { throw Object.assign(new Error("The request was not valid JSON."), { status: 400 }); }
}

// `fetch` is injectable so tests never reach xAI, Twilio or a CRM.
export function createSettingsRoutes({ store = settings, fetch = globalThis.fetch, publicBase = envPublicBase,
  loadCrm = async () => (await import("./crm/index.mjs")).crm,
  placeCall = async (...args) => (await import("./dialer.mjs")).placeCall(...args) } = {}) {
  const timed = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const unreachable = (who, err) => ({ ok: false, message: `Could not reach ${who}: ${err.name === "TimeoutError" ? "no answer in 10 seconds" : err.message}.` });

  const twilio = async (path, init = {}) => {
    const sid = store.get("TWILIO_ACCOUNT_SID");
    const basic = Buffer.from(`${sid}:${store.get("TWILIO_AUTH_TOKEN")}`).toString("base64");
    const res = await timed(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}${path}`,
      { ...init, headers: { Authorization: `Basic ${basic}`, ...init.headers } });
    return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
  };
  const twilioMissing = () => (!store.isSet("TWILIO_ACCOUNT_SID") || !store.isSet("TWILIO_AUTH_TOKEN")
    ? "Add your Twilio Account SID and Auth Token first." : null);
  const twilioNumber = async () => {
    const number = store.get("TWILIO_PHONE_NUMBER");
    const r = await twilio(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`);
    if (r.status === 401) return { error: "Twilio rejected the Account SID and Auth Token. Copy both again from the Twilio console." };
    if (!r.ok) return { error: `Twilio answered with error ${r.status} while looking up your number.` };
    return { found: r.body?.incoming_phone_numbers?.[0] ?? null, number };
  };

  const TESTS = {
    async xai() {
      if (!store.isSet("X_API_KEY")) return { ok: false, message: "Add your xAI API key first." };
      let res;
      try { res = await timed("https://api.x.ai/v1/models", { headers: { Authorization: `Bearer ${store.get("X_API_KEY")}` } }); } catch (err) { return unreachable("xAI", err); }
      if (res.ok) return { ok: true, message: "xAI accepted your key." };
      if (res.status === 401 || res.status === 403) return { ok: false, message: "xAI rejected this key. Copy it again from console.x.ai." };
      return { ok: false, message: `xAI answered with error ${res.status}. Try again in a minute.` };
    },
    async twilio() {
      const missing = twilioMissing();
      if (missing) return { ok: false, message: missing };
      let account, lookup;
      try {
        account = await twilio(".json");
        if (account.status === 401) return { ok: false, message: "Twilio rejected the Account SID and Auth Token. Copy both again from the Twilio console." };
        if (!account.ok) return { ok: false, message: `Twilio answered with error ${account.status}.` };
        if (!store.isSet("TWILIO_PHONE_NUMBER")) return { ok: true, message: "Your Twilio account works. Add your Twilio phone number next." };
        lookup = await twilioNumber();
      } catch (err) { return unreachable("Twilio", err); }
      if (lookup.error) return { ok: false, message: lookup.error };
      if (!lookup.found) return { ok: false, message: `Your Twilio account works, but ${lookup.number} is not one of its phone numbers. Check the number in the Twilio console under Phone Numbers.` };
      return { ok: true, message: `Your Twilio account works and ${lookup.number} is on it.` };
    },
    async crm() {
      try {
        const leads = await (await loadCrm()).listQueue();
        return { ok: true, message: `Connected. ${leads.length} ${leads.length === 1 ? "lead is" : "leads are"} ready to call.` };
      } catch (err) { return { ok: false, message: `The CRM did not answer: ${err.message}` }; }
    },
    async public() {
      let base;
      try { base = publicBase(); } catch { return { ok: false, message: "Add the public address of this server first." }; }
      let res;
      try { res = await timed(`${base}/healthz`); } catch (err) { return unreachable(base, err); }
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok === true) return { ok: true, message: `Twilio can reach this server at ${base}.` };
      return { ok: false, message: `${base} answered, but not as this server (status ${res.status}). Check the address and your proxy or tunnel.` };
    },
  };

  async function pointNumber() {
    const missing = twilioMissing() ?? (store.isSet("TWILIO_PHONE_NUMBER") ? null : "Add your Twilio phone number first.");
    if (missing) return { ok: false, message: missing };
    let base;
    try { base = publicBase(); } catch { return { ok: false, message: "Add the public address of this server first." }; }
    const fallback = store.get("INBOUND_FALLBACK_NUMBER");
    const set = {
      VoiceUrl: `${base}/twilio/inbound`,
      VoiceMethod: "POST",
      VoiceFallbackUrl: fallback ? `https://twimlets.com/forward?PhoneNumber=${encodeURIComponent(fallback)}` : "",
    };
    try {
      const lookup = await twilioNumber();
      if (lookup.error) return { ok: false, message: lookup.error };
      if (!lookup.found) return { ok: false, message: `${lookup.number} is not one of this Twilio account's phone numbers.` };
      const r = await twilio(`/IncomingPhoneNumbers/${encodeURIComponent(lookup.found.sid)}.json`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(set),
      });
      if (!r.ok) return { ok: false, message: `Twilio refused the change (error ${r.status}).` };
    } catch (err) { return unreachable("Twilio", err); }
    return { ok: true, message: `Calls to ${store.get("TWILIO_PHONE_NUMBER")} now come to this server${fallback ? `, and go to ${fallback} if it can't answer` : ""}.`, set };
  }

  // The dialer's own gate reads the process environment. This one reads the store the page edits, so a refusal matches what the page shows.
  const mayDial = (e164) => store.get("CONSENT_CONFIRMED") === "true"
    || (store.get("DIAL_ALLOWLIST") ?? "").split(/[\s,;]+/).some((n) => toE164(n) === e164);

  async function testCall(body) {
    const to = toE164(body.phone);
    if (!to) return { ok: false, message: "Enter a US phone number with 10 digits, such as 555 123 4567." };
    if (!mayDial(to)) return { ok: false, message: "That number is not on your test list. Add it under Outbound calling as a number the bot may call while testing, save, then try again." };
    const name = String(body.name ?? "").trim().slice(0, 40) || "there";
    const lead = { id: `adhoc-${Date.now().toString(36)}`, first_name: name, last_name: "", phone: to, state: "", timezone: "" };
    // Omitting source lets placeCall apply config.dialer.source.
    const source = typeof body.source === "string" && body.source ? body.source : undefined;
    try {
      const { callId } = await placeCall(lead, source ? { source } : {});
      console.log(`[settings] test call placed to ***-***-${to.slice(-4)}`);
      return { ok: true, callId };
    } catch (err) {
      console.error("[settings] test call failed:", String(err.message).replace(/\+?\d[\d\s().-]{8,}\d/g, "[number]"));
      return { ok: false, message: err.message };
    }
  }

  const payload = () => settingsPayload(store, publicBase);

  return async function handle(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    try {
      if (method === "GET" && (pathname === "/" || pathname === "/v2") && !url.searchParams.has("skip-setup") && !payload().checklist.ready) {
        res.writeHead(302, { location: "/settings" });
        res.end();
        return true;
      }
      if (method === "GET" && pathname === "/settings") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(await readFile(PAGE));
        return true;
      }
      if (pathname === "/api/settings") {
        if (method === "GET") send(res, 200, payload());
        else if (method === "PUT") {
          const update = validateUpdate(await readJson(req), store);
          if (Object.keys(update.errors).length) { send(res, 422, { ok: false, errors: update.errors }); return true; }
          const tokenBefore = store.get("DASHBOARD_TOKEN");
          store.save(update);
          const changed = [...Object.keys(update.values), ...update.clear];
          if (changed.length) console.log(`[settings] saved ${changed.join(", ")}`);
          const tokenAfter = store.get("DASHBOARD_TOKEN");
          send(res, 200, { ok: true, ...payload() }, tokenAfter !== tokenBefore ? { "set-cookie": sessionCookie(tokenAfter) } : {});
        } else send(res, 405, { ok: false, error: "Use GET or PUT." });
        return true;
      }
      const test = /^\/api\/settings\/test\/([a-z]+)$/.exec(pathname);
      if (test && method === "POST") {
        const run = Object.hasOwn(TESTS, test[1]) ? TESTS[test[1]] : null;
        if (run) send(res, 200, await run());
        else send(res, 404, { ok: false, message: `There is no test called "${test[1]}".` });
        return true;
      }
      if (pathname === "/api/twilio/point-number" && method === "POST") {
        send(res, 200, await pointNumber());
        return true;
      }
      if (pathname === "/api/test-call" && method === "POST") {
        send(res, 200, await testCall(await readJson(req)));
        return true;
      }
      return false;
    } catch (err) {
      send(res, err.status ?? 500, { ok: false, error: err.status ? err.message : "Something went wrong saving settings. See the server log." });
      if (!err.status) console.error("[settings]", err.message);
      return true;
    }
  };
}
