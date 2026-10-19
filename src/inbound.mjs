// Calls to your Twilio number, whether a caller dials it directly or a call platform routes
// consumers to it. decide() says whether the bot takes the call or it goes to the fallback
// number, and the *Twiml builders answer Twilio's webhook. Everything is read from config.inbound
// at the moment of the call, so Settings changes apply to the next caller.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { config } from "./config.mjs";

// INBOUND_DATA_DIR relocates the daily count (the tests use it).
const DIR = process.env.INBOUND_DATA_DIR ? pathToFileURL(`${process.env.INBOUND_DATA_DIR}/`) : new URL("../data/", import.meta.url);
const STORE = new URL("inbound.json", DIR);

export const LOOP_WINDOW_MS = 15 * 60000;
export const RECENT_LEAD_MINUTES = 30;

let store = null;
const days = () => (store ??= existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : { days: {} }).days;

// callId -> { at, started }. A call that never connects its stream would hold a slot, so an
// unstarted claim is dropped after UNSTARTED_CLAIM_MS and a started one after the longest allowed call.
export const UNSTARTED_CLAIM_MS = 45000;
const active = new Map();
// Callers the bot has had lately. If a transfer sends the caller straight back here, they
// go to the fallback instead of starting over with the bot.
const recent = new Map();

const tenDigits = (n) => String(n ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const dayKey = (now, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const hourIn = (now, tz) => Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(now)) % 24;

// The routing rule on its own, so it can be tested without Twilio or a clock.
export function decide({ enabled, maxActive, maxPerDay, hours: [start, end], activeCount, todayCount, hour, looped = false }) {
  if (!enabled) return { to: "fallback", reason: "inbound bot disabled" };
  if (looped) return { to: "fallback", reason: "caller was just with the bot" };
  if (hour < start || hour >= end) return { to: "fallback", reason: `outside bot hours ${start}:00-${end}:00` };
  if (activeCount >= maxActive) return { to: "fallback", reason: `bot busy (${activeCount}/${maxActive} active)` };
  if (todayCount >= maxPerDay) return { to: "fallback", reason: `daily bot cap reached (${todayCount}/${maxPerDay})` };
  return { to: "bot" };
}

function sweep(now) {
  const staleAfter = ((config.maxCallMinutes ?? 20) + 5) * 60000;
  for (const [id, c] of active) if (now.getTime() - c.at > (c.started ? staleAfter : UNSTARTED_CLAIM_MS)) active.delete(id);
  for (const [phone, at] of recent) if (now.getTime() - at > LOOP_WINDOW_MS) recent.delete(phone);
}

export function route(from, now = new Date()) {
  sweep(now);
  const c = config.inbound, caller = tenDigits(from), ours = tenDigits(process.env.TWILIO_PHONE_NUMBER);
  // No caller ID ("anonymous", empty) is never a loop: every such caller would look like the same one.
  const looped = caller !== "" && ((ours !== "" && caller === ours) || recent.has(caller));
  return decide({ enabled: c.enabled, maxActive: c.maxActive, maxPerDay: c.maxPerDay, hours: c.hours,
    activeCount: active.size, todayCount: days()[dayKey(now, c.tz)] ?? 0, hour: hourIn(now, c.tz), looped });
}

export function claim(callId, from, now = new Date()) {
  active.set(callId, { at: now.getTime(), started: false });
  const caller = tenDigits(from);
  if (caller !== "") recent.set(caller, now.getTime());
  const day = dayKey(now, config.inbound.tz);
  const counts = days();
  const today = (counts[day] ?? 0) + 1;
  for (const k of Object.keys(counts)) delete counts[k];
  counts[day] = today;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(STORE, JSON.stringify(store));
}

export const markStarted = (callId) => { const c = active.get(callId); if (c) c.started = true; };
export const release = (callId) => active.delete(callId);

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms).unref())]);

// Best effort, and never delays the answer past 2.5 seconds. "any" takes the newest lead with
// this number; "recent" takes only a lead created in the last half hour, for call platforms that
// post a fresh lead per call, where an older lead is a past inquiry and maybe someone else.
export async function lookupCaller(from, { adapter } = {}) {
  const match = config.inbound.match;
  const digits = tenDigits(from);
  if (match === "off" || digits.length !== 10) return null;
  const crm = adapter ?? (await import("./crm/index.mjs")).crm;
  const opts = match === "recent" ? { recentMinutes: RECENT_LEAD_MINUTES } : {};
  return withTimeout(Promise.resolve().then(() => crm.findByPhone(digits, opts)).catch(() => null), 2500);
}

const esc = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function botTwiml({ base, params, acceptDigits = config.inbound.acceptDigits }) {
  const stream = `<Stream url="${esc(base.replace(/^https/, "wss"))}/twilio-stream">${
    Object.entries(params).map(([k, v]) => `<Parameter name="${esc(k)}" value="${esc(v)}"/>`).join("")}</Stream>`;
  return `<Response>${acceptDigits ? `<Play digits="${esc(acceptDigits)}"/>` : ""}<Connect>${stream}</Connect></Response>`;
}

export function fallbackTwiml({ number = config.inbound.fallbackNumber, callerId } = {}) {
  if (!number) return `<Response><Say>Sorry, no one is available right now. Please call back shortly.</Say></Response>`;
  return `<Response><Dial timeout="25"${callerId ? ` callerId="${esc(callerId)}"` : ""}><Number>${esc(number)}</Number></Dial></Response>`;
}
