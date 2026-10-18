import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { initialState, reduce, validate } from "./call-state.mjs";

const calls = new Map();
const subscribers = new Set();

// Each call's accepted events are appended to data/calls/<callId>.jsonl and
// replayed on startup, so the map keeps its history across restarts.
const LOG_DIR = process.env.CALL_LOG_DIR === "off" ? null : new URL("../data/calls/", import.meta.url);
if (LOG_DIR) {
  mkdirSync(LOG_DIR, { recursive: true });
  for (const f of readdirSync(LOG_DIR).filter((f) => f.endsWith(".jsonl"))) {
    const events = readFileSync(new URL(f, LOG_DIR), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    if (events[0]?.type !== "call_started") continue;
    calls.set(events[0].callId, { events, state: events.slice(1).reduce(reduce, initialState(events[0])) });
  }
}

export function dispatch(input) {
  const event = { ...input, at: input.at ?? Date.now() };
  const { callId } = event;
  if (!callId) return { ok: false, error: "Event has no callId" };
  let call = calls.get(callId);
  if (event.type === "call_started") {
    if (call) return { ok: false, error: `Call ${callId} already started` };
    call = { events: [], state: initialState(event) };
    calls.set(callId, call);
  } else if (!call) {
    return { ok: false, error: `Unknown call ${callId}: send call_started first` };
  } else {
    const error = validate(call.state, event);
    if (error) return { ok: false, error };
    call.state = reduce(call.state, event);
  }
  call.events.push(event);
  if (LOG_DIR) appendFileSync(new URL(`${callId}.jsonl`, LOG_DIR), JSON.stringify(event) + "\n");
  for (const fn of subscribers) fn({ callId, event, state: call.state });
  return { ok: true, state: call.state };
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export const getState = (id) => calls.get(id)?.state;
export const snapshot = () => [...calls.values()].map((c) => c.state);

export function summaries() {
  return snapshot().map((s) => ({
    callId: s.callId, lead: s.lead, stage: s.stage, outcome: s.outcome, crmStatus: s.crmStatus,
    score: s.score, livesLeft: s.livesLeft, startedAt: s.startedAt, endedAt: s.endedAt,
  }));
}
