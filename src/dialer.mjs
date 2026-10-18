// Calls CRM leads back through the bot (the queue comes from the CRM adapter).
// One call per free line, only inside the lead's local calling window, a few
// attempts spaced apart, and a hard daily cap. In demo mode only numbers on
// DIAL_ALLOWLIST are dialed.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { twilio } from "../scripts/twilio.mjs";
import { env } from "../scripts/env.mjs";
import { crm } from "./crm/index.mjs";
import { config as app, checkDial, toE164, localBase, localAuthHeaders } from "./config.mjs";

const DATA_DIR = new URL("../data/", import.meta.url);
const STORE = new URL("../data/dialer.json", import.meta.url);
const TERMINAL = new Set(["completed", "no-answer", "busy", "failed", "canceled"]);

export const config = {
  source: process.env.DIALER_SOURCE ?? "tv_callback",
  lines: Number(process.env.DIALER_LINES ?? 1),
  maxAttempts: Number(process.env.DIALER_MAX_ATTEMPTS ?? 3),
  gapMinutes: Number(process.env.DIALER_GAP_MINUTES ?? 120),
  windowStart: 9, windowEnd: 20,                       // lead's local time, 9 AM to 8 PM
  maxCallsPerDay: Number(process.env.DIALER_MAX_CALLS_PER_DAY ?? 25),
};

mkdirSync(DATA_DIR, { recursive: true });
const store = existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : { attempts: {} };
const save = () => writeFileSync(STORE, JSON.stringify(store, null, 1));
const today = () => new Date().toISOString().slice(0, 10);
const callsToday = () => Object.values(store.attempts).flat().filter((a) => a.at.slice(0, 10) === today()).length;

let running = false, active = 0;
const live = new Map();
const refused = new Set();

export function publicBase() {
  if (process.env.PUBLIC_BASE) return process.env.PUBLIC_BASE.replace(/\/+$/, "");
  const log = new URL("../data/tunnel.log", import.meta.url);
  const hits = existsSync(log) ? readFileSync(log, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g) : null;
  if (!hits) throw new Error("No public URL: start the tunnel (data/tunnel.log) or set PUBLIC_BASE");
  return hits.at(-1);
}

function localHour(timezone) {
  try { return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone || "America/Chicago" }).format(new Date())) % 24; }
  catch { return null; }
}

export async function eligibleLeads() {
  const leads = await crm.listQueue();
  const now = Date.now();
  return leads.filter((l) => {
    const to = toE164(l.phone);
    if (l.dnc || !to) return false;
    if (!app.consentConfirmed && !app.dialAllowlist.includes(to)) {
      if (!refused.has(l.id)) { refused.add(l.id); checkDial(to); }
      return false;
    }
    const tries = store.attempts[l.id] ?? [];
    const hour = localHour(l.timezone);
    return !live.has(l.id)
      && tries.length < config.maxAttempts
      && (!tries.length || now - Date.parse(tries.at(-1).at) >= config.gapMinutes * 60000)
      && !tries.some((t) => ["answered", "transferred", "won"].includes(t.result))
      && hour != null && hour >= config.windowStart && hour < config.windowEnd;
  });
}

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

// lead: { id, first_name, last_name, phone, state } as the CRM adapter returns it.
export async function placeCall(lead, { source = config.source } = {}) {
  const to = toE164(lead.phone);
  if (!to) throw new Error("Lead has no usable US phone number");
  if (lead.dnc) throw new Error("Lead is flagged DNC");
  const gate = checkDial(to);
  if (!gate.ok) throw new Error(gate.reason);
  const base = publicBase();
  const { secret } = await (await fetch(`${localBase()}/stream-secret`, { headers: localAuthHeaders() })).json();
  const callId = `call-${Date.now().toString(36)}`;
  const params = { secret, callId, leadUid: lead.id ?? "", firstName: lead.first_name ?? "", lastName: lead.last_name ?? "",
    state: lead.state ?? "", agentName: app.agentName, source, publicBase: base };
  const twiml = `<Response><Connect><Stream url="${esc(base.replace(/^https/, "wss"))}/twilio-stream">${
    Object.entries(params).map(([k, v]) => `<Parameter name="${k}" value="${esc(v)}"/>`).join("")}</Stream></Connect></Response>`;
  const call = await twilio("/Calls.json", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      To: to, From: env("TWILIO_PHONE_NUMBER"), Twiml: twiml, Timeout: "30",
      Record: "true", RecordingChannels: "dual",
      MachineDetection: "Enable", AsyncAmd: "true", AsyncAmdStatusCallbackMethod: "POST",
      AsyncAmdStatusCallback: `${base}/twilio/amd?callId=${encodeURIComponent(callId)}&secret=${encodeURIComponent(secret)}`,
    }),
  });
  return { callSid: call.sid, callId, last4: to.slice(-4) };
}

async function waitForEnd(callSid) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const c = await twilio(`/Calls/${callSid}.json`).catch(() => null);
    if (c && TERMINAL.has(c.status)) return c;
  }
}

async function work(lead) {
  active++;
  live.set(lead.id, true);
  const attempt = { at: new Date().toISOString(), result: "dialing" };
  (store.attempts[lead.id] ??= []).push(attempt);
  save();
  try {
    const { callSid, callId } = await placeCall(lead);
    Object.assign(attempt, { callSid, callId });
    const c = await waitForEnd(callSid);
    const hub = await (await fetch(`${localBase()}/calls/${callId}`, { headers: localAuthHeaders() })).json().catch(() => null);
    attempt.result = c.status !== "completed" ? c.status : hub?.outcome ?? (c.answered_by?.startsWith("machine") ? "voicemail" : "answered");
    attempt.seconds = Number(c.duration ?? 0);
    if (["no-answer", "busy", "failed", "voicemail"].includes(attempt.result)) {
      const n = store.attempts[lead.id].length;
      await crm.addNote(lead, `AI callback attempt ${n} of ${config.maxAttempts}: ${attempt.result}${n < config.maxAttempts ? `, next try in ${config.gapMinutes / 60}h or later` : ", no more attempts"}`).catch(() => {});
    }
  } catch (e) {
    attempt.result = "error";
    attempt.error = e.message;
  } finally {
    save();
    live.delete(lead.id);
    active--;
  }
}

async function loop() {
  while (running) {
    try {
      if (callsToday() >= config.maxCallsPerDay) { running = false; console.log(`[dialer] daily cap of ${config.maxCallsPerDay} calls reached, stopping`); break; }
      if (active < config.lines) {
        const [next] = await eligibleLeads();
        if (next) { work(next); await new Promise((r) => setTimeout(r, 3000)); continue; }
      }
    } catch (e) { console.log("[dialer]", e.message); }
    await new Promise((r) => setTimeout(r, 15000));
  }
}

export function start(overrides = {}) {
  Object.assign(config, Object.fromEntries(Object.entries(overrides).filter(([k]) => k in config)));
  if (!running) { running = true; loop(); }
  return status();
}
export function stop() { running = false; return status(); }
export function status() {
  return { running, active, callsToday: callsToday(), config, recent: Object.entries(store.attempts).flatMap(([id, a]) => a.map((x) => ({ lead: String(id).slice(0, 6), ...x }))).slice(-10) };
}
