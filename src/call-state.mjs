import { STAGES, FACTS, HANDOFF_REQUIRES, OBJECTION_LIMIT, canTransition, isTerminal, UNIVERSAL_EXITS } from "./flow.mjs";

const TRANSCRIPT_CAP = 50;
const ACTION = { price: "present price", handoff: "hand off" };
const REQUIRE_HINT = {
  tier: "call get_quote first",
  quote: "run the quote first",
  case_confirmed: "recap their reasons and get them to confirm you have it right (save case_confirmed)",
};

export function initialState(e) {
  return {
    callId: e.callId, lead: e.lead ?? {}, startedAt: e.at, endedAt: null, outcome: null, crmStatus: null,
    stage: "dialing", trail: [{ stage: "dialing", at: e.at }], traveled: [],
    mood: "neutral", facts: {}, quote: null,
    objections: [], unresolvedAfterPrice: 0, livesLeft: OBJECTION_LIMIT, pricePresented: false,
    score: 0, badges: [], transcript: [],
  };
}

function missingRequirement(state, to) {
  for (const need of STAGES[to].requires ?? []) {
    const ok = need === "quote" ? state.quote !== null : state.facts[need] != null;
    if (ok) continue;
    const missingFacts = (STAGES[to].requires ?? []).filter((k) => k !== "quote" && !REQUIRE_HINT[k] && state.facts[k] == null);
    if (!REQUIRE_HINT[need] && missingFacts.length)
      return `Can't ${ACTION[to] ?? `move to ${STAGES[to].label}`} yet: still need ${missingFacts.map((k) => FACTS[k]?.label ?? k).join(", ")}. Keep digging and save them first`;
    return `Can't ${ACTION[to] ?? `enter ${STAGES[to].label}`} yet: ${REQUIRE_HINT[need] ?? `${need} is missing`}`;
  }
  if (to === "handoff") {
    const missing = HANDOFF_REQUIRES.filter((k) => state.facts[k] == null);
    if (missing.length) return `Can't hand off yet: still need ${missing.map((k) => FACTS[k].label).join(", ")}`;
  }
  return null;
}

export function validate(state, event) {
  if (isTerminal(state.stage) && event.type !== "transcript" && event.type !== "call_ended")
    return `The call already ended (${state.outcome}), so ${event.type} events are no longer accepted`;
  switch (event.type) {
    case "call_started": return "This call has already started";
    case "stage": {
      const to = event.to;
      if (!STAGES[to]) return `Unknown stage "${to}"`;
      if (!canTransition(state.stage, to)) {
        const allowed = [...new Set([...STAGES[state.stage].next, ...UNIVERSAL_EXITS])].join(", ");
        return `Can't go from ${state.stage} to ${to}: from ${state.stage} you can go to ${allowed}`;
      }
      return missingRequirement(state, to);
    }
    case "fact":
      if (!FACTS[event.key]) return `Unknown fact "${event.key}"`;
      return event.value == null || event.value === "" ? `Fact "${event.key}" needs a value` : null;
    case "quote":
      return event.tier && Array.isArray(event.options) && event.options.length
        ? null : "A quote needs a tier and at least one option";
    case "objection":
      if (!event.kind) return "An objection needs a kind";
      return event.resolved == null || typeof event.resolved === "boolean" ? null : "resolved must be true, false, or omitted";
    case "transcript":
      return (event.speaker === "bot" || event.speaker === "prospect") && typeof event.text === "string"
        ? null : "A transcript line needs speaker bot|prospect and text";
    case "call_ended": return null;
    default: return `Unknown event type "${event.type}"`;
  }
}

function award(s, badge) {
  if (!s.badges.includes(badge)) s.badges.push(badge);
}

// Stages that prove the last objection was overcome.
const PROGRESS = new Set(["commit", "application", "recap", "handoff"]);
const pending = (s) => s.objections.find((o) => o.afterPrice && o.resolved === null);

function overcome(s, o) {
  o.resolved = true;
  s.score += 15;
  award(s, "Objection Crusher");
}

function notOvercome(s, o, at) {
  o.resolved = false;
  s.unresolvedAfterPrice++;
  s.livesLeft = OBJECTION_LIMIT - s.unresolvedAfterPrice;
  // The reducer ends the call itself so a replay of the log reaches "lost" without the bot's help.
  if (s.unresolvedAfterPrice >= OBJECTION_LIMIT) enter(s, "lost", at);
}

function enter(s, to, at) {
  const open = pending(s);
  if (open && PROGRESS.has(to)) overcome(s, open);
  const first = !s.trail.some((t) => t.stage === to);
  s.traveled.push(`${s.stage}>${to}`);
  s.trail.push({ stage: to, at });
  s.stage = to;
  if (first && STAGES[to].lane !== "exit") s.score += 10;
  if (to === "confirm") award(s, "Disclosed");
  if (to === "price") { s.pricePresented = true; s.score += 25; award(s, "Price Presented"); }
  if (to === "application") award(s, "App Started");
  if (to === "handoff") { s.score += 100; award(s, "Closed"); }
  if (isTerminal(to)) {
    s.outcome = STAGES[to].terminal;
    s.crmStatus = STAGES[to].crmStatus ?? null;
    s.endedAt = at;
  }
}

export function reduce(state, event) {
  if (validate(state, event)) return state;
  const s = structuredClone(state);
  switch (event.type) {
    case "stage":
      if (event.mood) s.mood = event.mood;
      enter(s, event.to, event.at);
      break;
    case "fact":
      s.facts[event.key] = event.value;
      if (event.key === "case_confirmed") award(s, "Case Built");
      break;
    case "quote":
      s.quote = { tier: event.tier, options: event.options };
      s.facts.tier = event.tier;
      break;
    case "objection": {
      // Without an explicit verdict an objection stays open: moving the call
      // forward overcomes it, and a fresh objection first means it wasn't.
      const afterPrice = s.pricePresented;
      const open = afterPrice && pending(s);
      if (open) notOvercome(s, open, event.at);
      if (isTerminal(s.stage)) break;
      const o = { kind: event.kind, resolved: event.resolved ?? null, at: event.at, afterPrice };
      s.objections.push(o);
      if (!afterPrice || o.resolved === null) break;
      if (o.resolved) overcome(s, o);
      else notOvercome(s, o, event.at);
      break;
    }
    case "transcript":
      s.transcript.push({ at: event.at, speaker: event.speaker, text: event.text });
      s.transcript = s.transcript.slice(-TRANSCRIPT_CAP);
      break;
    case "call_ended":
      if (!isTerminal(s.stage)) enter(s, "hangup", event.at);
      else s.endedAt ??= event.at;
      break;
  }
  return s;
}
