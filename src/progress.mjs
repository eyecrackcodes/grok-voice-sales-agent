// Shared by the CRM adapters and the bridge: which stages write the case to the CRM while a
// call is still going, and the check that keeps a caller's answers off someone else's lead.
import { config } from "./config.mjs";

// Entering one of these stages writes the case so far to the lead, so whoever owns the lead
// sees notes while the call is still going. Keyed by the stage being entered.
export const MILESTONES = { case_recap: "needs and health captured", price: "quote presented", recap: "application captured" };

// Each milestone is written once per call. A milestone reached before the lead is known
// waits (the latest one) until leadFound().
export function progressTracker() {
  const written = new Set();
  let pending = null;
  const take = (stage) => (written.has(stage) ? null : (written.add(stage), stage));
  return {
    enter(stage, hasLead) {
      if (!MILESTONES[stage] || written.has(stage)) return null;
      if (!hasLead) { pending = stage; return null; }
      return take(stage);
    },
    leadFound() {
      const stage = pending;
      pending = null;
      return stage && take(stage);
    },
  };
}

// Caller ID reaches whoever owns the phone line, so the person on the call may not be the
// person on the lead. A shared first three letters counts as the same person (Bob/Robert is not
// caught, Kathy/Katherine is). An empty side can't be judged, so it matches.
const letters = (x) => String(x ?? "").toLowerCase().replace(/[^a-z]/g, "");
export function namesMatch(crmName, capturedName) {
  const a = letters(crmName), b = letters(capturedName);
  if (!a || !b) return true;
  return a === b || (a.length >= 3 && b.length >= 3 && a.slice(0, 3) === b.slice(0, 3));
}

// Only an inbound caller-ID match can be the wrong person: an outbound call dialed this lead,
// and a legal name that differs from the lead's (Bob for Robert) is still the same client.
export const isNameMismatch = (state, crmFirstName) =>
  state.lead?.source === "inbound" && !namesMatch(crmFirstName, state.facts.first_name);

export const mismatchText = (state, crmFirstName) =>
  `AI call (${config.botName}): the caller gave the name "${state.facts.first_name}" but this lead is "${crmFirstName}". Details were not written to this lead and its status was not changed.`;

// Runs jobs one after another, in the order they were queued. A failed job doesn't block the next.
export function serialQueue() {
  let chain = Promise.resolve();
  return (job) => {
    const run = chain.then(job);
    chain = run.catch(() => {});
    return run;
  };
}
