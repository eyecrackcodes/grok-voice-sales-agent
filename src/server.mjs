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
import { config, isLoopbackHost, warnConsentOnce } from "./config.mjs";
import { validTwilioSignature } from "./twilio-signature.mjs";
import { authorize } from "./dashboard-auth.mjs";

const PORT = config.port;
const HOST = config.host;
if (!isLoopbackHost(HOST) && !config.dashboardToken) {
  console.error(`Refusing to start: HOST=${HOST} is not a loopback address and DASHBOARD_TOKEN is not set. `
    + "Set DASHBOARD_TOKEN to a long random string, or leave HOST at 127.0.0.1.");
  process.exit(1);
}
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/twiml/whisper" || url.pathname === "/twilio/amd") return twilioRoute(req, res, url).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
  if (viaTunnel(req)) return json(res, 404, { ok: false });
  const access = authorize(req, url, config.dashboardToken);
  if (!access.ok) return json(res, access.status, { ok: false, error: access.status === 401 ? "Dashboard token required" : "Forbidden" });
  if (access.setCookie) res.setHeader("set-cookie", access.setCookie);
  const { pathname } = url;
  const parts = pathname.split("/").filter(Boolean);
  try {
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
  const missing = ["X_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "VAULT_KEY"].filter((k) => !process.env[k]);
  if (missing.length) console.warn(`Missing from .env: ${missing.join(", ")}. The dashboard works, but calls need these. See .env.example.`);
  if (!config.consentConfirmed) console.log(`Demo mode: only numbers in DIAL_ALLOWLIST can be dialed (${config.dialAllowlist.length} listed).`);
  warnConsentOnce();
});
