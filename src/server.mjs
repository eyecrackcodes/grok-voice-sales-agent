import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { LANES, STAGES, UNIVERSAL_EXITS, FACTS, OBJECTION_LIMIT, HANDOFF_REQUIRES } from "./flow.mjs";
import { dispatch, subscribe, getState, snapshot, summaries } from "./hub.mjs";
import { handleTwilioStream } from "./bridge.mjs";
import { runRoleplay } from "./roleplay.mjs";
import { whisperTwiml } from "./transfer.mjs";
import { twilio } from "../scripts/twilio.mjs";
import * as dialer from "./dialer.mjs";
import * as inbound from "./inbound.mjs";
import { config, isLoopbackHost, warnConsentOnce } from "./config.mjs";
import { validTwilioSignature } from "./twilio-signature.mjs";
import { authorize } from "./dashboard-auth.mjs";
import { settings } from "./settings.mjs";
import { createSettingsRoutes } from "./settings-routes.mjs";

const PORT = config.port;
const HOST = config.host;
if (!isLoopbackHost(HOST) && !config.dashboardToken) {
  console.error(`Refusing to start: HOST=${HOST} is not a loopback address and DASHBOARD_TOKEN is not set. `
    + "Set DASHBOARD_TOKEN to a long random string, or leave HOST at 127.0.0.1.");
  process.exit(1);
}
if (settings.ensureVaultKey()) console.log(`[settings] Created VAULT_KEY in ${settings.file}. Back that file up: losing the key makes saved SSN and bank details unreadable.`);
const settingsRoutes = createSettingsRoutes({ publicBase: dialer.publicBase });

const MAP_HTML = fileURLToPath(new URL("../public/map.html", import.meta.url));
const MAP_V2_HTML = fileURLToPath(new URL("../public/map-v2.html", import.meta.url));
const FLOW = { LANES, STAGES, UNIVERSAL_EXITS, FACTS, OBJECTION_LIMIT, HANDOFF_REQUIRES };
const STREAM_SECRET = randomUUID();

// The tunnel exposes this server to the internet. Anything arriving through it
// may only open the Twilio media stream; the map and the event API stay local.
const viaTunnel = (req) => Boolean(req.headers["cf-connecting-ip"]);

const json = (res, status, body) => {
  if (res.headersSent) return res.end();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

function stream(req, res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ snapshot: snapshot() });
  const unsubscribe = subscribe(send);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => { unsubscribe(); clearInterval(ping); });
}

async function readForm(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 65536) { req.destroy(); throw new Error("request body too large"); }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

// Twilio signs the exact URL it requested (public base, path, query). The public base
// comes from PUBLIC_BASE or the tunnel log.
function signedByTwilio(req, params) {
  // Escape hatch for proxies that rewrite the URL Twilio signed; the per-process secret still applies.
  if (process.env.TWILIO_SIGNATURE_CHECK === "off") return true;
  try {
    const token = process.env.TWILIO_AUTH_TOKEN;
    return validTwilioSignature(req.headers["x-twilio-signature"], `${dialer.publicBase()}${req.url}`, params, token);
  } catch (err) {
    console.error("[twilio] cannot verify signature:", err.message);
    return false;
  }
}

// Twilio-facing routes: the only HTTP paths the tunnel may reach. Each needs a valid
// X-Twilio-Signature and the per-process secret.
async function twilioRoute(req, res, url) {
  const q = Object.fromEntries(url.searchParams);
  const form = req.method === "POST" ? await readForm(req) : {};
  if (!signedByTwilio(req, form)) { console.error(`[twilio] rejected ${url.pathname}: missing or invalid X-Twilio-Signature`); res.writeHead(403); return res.end(); }
  if (q.secret !== STREAM_SECRET) { res.writeHead(403); return res.end(); }
  if (url.pathname === "/twiml/whisper") {
    const xml = whisperTwiml(q.callId, q.secret) ?? "<Response/>";
    res.writeHead(200, { "content-type": "text/xml" });
    return res.end(xml);
  }
  if (url.pathname === "/twilio/amd") {
    // No voicemails are left: a machine or fax means hang up and try again later.
    if (/^(machine|fax)/.test(form.AnsweredBy ?? "")) {
      const state = getState(q.callId);
      if (state && !state.endedAt) dispatch({ callId: q.callId, type: "stage", to: "voicemail" });
      await twilio(`/Calls/${form.CallSid}.json`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ Status: "completed" }) }).catch(() => {});
    }
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(404);
  res.end();
}

// ---- inbound calls: Twilio posts here when someone calls the Twilio number ----
// The path is fixed in the Twilio console, so there is no per-call secret to check; the signature
// is the gate. The caller is looked up so the CRM write lands on their lead, but the bot is never
// told the looked-up name: caller ID can belong to someone else, so the bot asks who is calling.
async function inboundRoute(req, res) {
  const form = await readForm(req);
  if (!signedByTwilio(req, form)) { console.error("[twilio] rejected /twilio/inbound: missing or invalid X-Twilio-Signature"); res.writeHead(403); return res.end(); }
  const xml = (body) => { res.writeHead(200, { "content-type": "text/xml" }); res.end(body); };
  const from = form.From ?? "";
  try {
    const decision = inbound.route(from);
    if (decision.to !== "bot") {
      console.log(`[inbound] to fallback: ${decision.reason}`);
      return xml(inbound.fallbackTwiml({ callerId: from }));
    }
    const callId = `in-${randomUUID().slice(0, 8)}`;
    inbound.claim(callId, from);
    const lead = await inbound.lookupCaller(from);
    console.log(`[inbound] ${callId} to the bot${lead ? " (lead found)" : ""}`);
    return xml(inbound.botTwiml({ base: dialer.publicBase(), params: {
      secret: STREAM_SECRET, callId, leadUid: lead?.id ?? "", source: "inbound", callerPhone: from, publicBase: dialer.publicBase() } }));
  } catch (err) {
    console.error("[inbound] failed, sending the caller to the fallback:", err.message);
    return xml(inbound.fallbackTwiml({ callerId: from }));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST" && url.pathname === "/twilio/inbound") return inboundRoute(req, res).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
  if (url.pathname === "/twiml/whisper" || url.pathname === "/twilio/amd") return twilioRoute(req, res, url).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
  // Public on purpose: the Settings page fetches it through PUBLIC_BASE to prove Twilio can reach this server.
  if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
  if (viaTunnel(req)) return json(res, 404, { ok: false });
  const access = authorize(req, url, config.dashboardToken);
  if (!access.ok) return json(res, access.status, { ok: false, error: access.error ?? (access.status === 401 ? "Dashboard token required" : "Forbidden") });
  if (access.setCookie) res.setHeader("set-cookie", access.setCookie);
  const { pathname } = url;
  const parts = pathname.split("/").filter(Boolean);
  try {
    if (await settingsRoutes(req, res, url)) return;
    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(await readFile(MAP_HTML));
    }
    if (req.method === "GET" && pathname === "/v2") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(await readFile(MAP_V2_HTML));
    }
    if (req.method === "GET" && pathname === "/flow") return json(res, 200, FLOW);
    if (req.method === "GET" && pathname === "/stream-secret") return json(res, 200, { secret: STREAM_SECRET });
    if (req.method === "GET" && pathname === "/calls") return json(res, 200, summaries());
    if (req.method === "GET" && pathname === "/stream") return stream(req, res);
    if (parts[0] === "calls" && parts.length === 2 && req.method === "GET") {
      const state = getState(parts[1]);
      return state ? json(res, 200, state) : json(res, 404, { ok: false, error: "Unknown call" });
    }
    if (req.method === "GET" && pathname === "/dialer") return json(res, 200, dialer.status());
    if (req.method === "POST" && pathname === "/dialer/start") return json(res, 200, dialer.start(await readJson(req)));
    if (req.method === "POST" && pathname === "/dialer/stop") return json(res, 200, dialer.stop());
    if (req.method === "POST" && pathname === "/roleplay") {
      const { persona = "dorothy" } = await readJson(req);
      return json(res, 200, { ok: true, callId: runRoleplay(persona) });
    }
    if (parts[0] === "calls" && parts[2] === "events" && parts.length === 3 && req.method === "POST") {
      const event = await readJson(req);
      const result = dispatch({ ...event, callId: parts[1] });
      return json(res, result.ok ? 200 : 422, result);
    }
    json(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    json(res, err instanceof SyntaxError ? 400 : 500, { ok: false, error: err.message });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const wsUrl = new URL(req.url, "http://localhost");
  if (wsUrl.pathname !== "/twilio-stream") return socket.destroy();
  // The per-call secret in the stream's start message is what authenticates this socket. The
  // signature check is untested against live media streams, so it only warns unless
  // TWILIO_STREAM_SIGNATURE=enforce, rather than risk dropping every real call.
  const signature = req.headers["x-twilio-signature"];
  if (signature) {
    let valid = false;
    try { valid = validTwilioSignature(signature, `${dialer.publicBase().replace(/^https/, "wss")}${req.url}`, {}, process.env.TWILIO_AUTH_TOKEN); } catch {}
    if (!valid && process.env.TWILIO_STREAM_SIGNATURE === "enforce") { console.error("[twilio] rejected /twilio-stream: invalid X-Twilio-Signature"); return socket.destroy(); }
    if (!valid) console.warn("[twilio] /twilio-stream signature did not verify; continuing on the per-call secret (set TWILIO_STREAM_SIGNATURE=enforce to reject)");
  }
  wss.handleUpgrade(req, socket, head, (ws) => handleTwilioStream(ws, STREAM_SECRET));
});

server.on("error", (err) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Set PORT to a free port.` : `Server error: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Mission Control on http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}/v2${config.dashboardToken ? " (token required)" : ""}`);
  console.log(`Settings on http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}/settings`);
  const missing = ["X_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"].filter((k) => !process.env[k]);
  if (missing.length) console.warn(`Not set yet: ${missing.join(", ")}. The dashboard works, but calls need these. Add them on the Settings page.`);
  if (!config.consentConfirmed) console.log(`Demo mode: only numbers in DIAL_ALLOWLIST can be dialed (${config.dialAllowlist.length} listed).`);
  warnConsentOnce();
});
