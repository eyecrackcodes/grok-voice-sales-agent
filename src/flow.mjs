// The outbound final expense call as a graph. Single source of truth for the
// server (which transitions are legal), the bot (which stage tool to call next)
// and the live map (what to draw).

export const OBJECTION_LIMIT = 4;

export const LANES = [
  { id: "open", label: "Open" },
  { id: "qualify", label: "Qualify" },
  { id: "underwrite", label: "Underwrite" },
  { id: "present", label: "Present" },
  { id: "close", label: "Close" },
  { id: "exit", label: "Exits" },
];

// next: stages reachable from this one besides the universal exits.
// requires: facts or events the server checks before allowing entry.
export const STAGES = {
  dialing:     { lane: "open", label: "Dialing", goal: "Prospect answers", next: ["intro", "voicemail", "no_answer"] },
  intro:       { lane: "open", label: "Intro", goal: "AI + recorded-line disclosure, name confirmed", next: ["confirm", "voicemail"] },
  confirm:     { lane: "open", label: "Confirm", goal: "State confirmed, coverage for self or loved one", next: ["agenda", "callback"] },
  agenda:      { lane: "qualify", label: "Set Agenda", goal: "Prospect agrees to a few questions", next: ["eligibility", "callback"] },
  eligibility: { lane: "qualify", label: "Eligibility", goal: "DOB, income source, deposit type", next: ["discovery", "not_qualified"] },
  discovery:   { lane: "qualify", label: "Discovery", goal: "Family, who we're protecting and why, current coverage, the pain in their words", next: ["coverage"] },
  coverage:    { lane: "qualify", label: "Coverage", goal: "Funeral experience, burial vs cremation, cost reality, amount agreed", next: ["health"],
    requires: ["marital_status", "protecting", "current_coverage", "pain", "aligned"] },
  health:      { lane: "underwrite", label: "Health", goal: "Tobacco, height/weight, meds, conditions", next: ["case_recap", "coverage"], requires: ["face_amount"] },
  case_recap:  { lane: "underwrite", label: "Recap Needs", goal: "Their why played back, confirmed, three guarantees", next: ["quote", "objection", "callback"] },
  quote:       { lane: "underwrite", label: "Quote", goal: "Carrier and tier matched", next: ["price", "not_qualified"], requires: ["case_confirmed", "tier"] },
  price:       { lane: "present", label: "Price", goal: "Options one at a time, each tied to their family", next: ["commit", "objection"],
    requires: ["quote"] },
  objection:   { lane: "present", label: "Objection", goal: "Objection overcome", next: ["price", "commit", "objection", "lost"] },
  commit:      { lane: "present", label: "Commit", goal: "Option chosen, budget confirmed", next: ["application", "objection", "transferred"] },
  application: { lane: "close", label: "Application", goal: "Legal name, beneficiary, verified address, draft date, SSN, verified bank", next: ["recap", "transferred"] },
  recap:       { lane: "close", label: "Recap", goal: "Prospect confirms the details", next: ["handoff", "objection", "transferred"] },
  handoff:     { lane: "close", label: "Handoff", goal: "Complete app in CRM, live transfer to submit", terminal: "won", crmStatus: 300 },
  transferred: { lane: "exit", label: "Transferred", goal: "Live transfer, agent finishes the app", terminal: "transferred", crmStatus: 290 },

  voicemail:     { lane: "exit", label: "Voicemail", terminal: "voicemail" },
  no_answer:     { lane: "exit", label: "No Answer", terminal: "no_answer" },
  callback:      { lane: "exit", label: "Callback", terminal: "callback", crmStatus: 50 },
  not_qualified: { lane: "exit", label: "Not Qualified", terminal: "not_qualified", crmStatus: 440 },
  lost:          { lane: "exit", label: "Lost", terminal: "lost", crmStatus: 420 },
  dnc:           { lane: "exit", label: "Do Not Call", terminal: "dnc", crmStatus: 500 },
  hangup:        { lane: "exit", label: "Hung Up", terminal: "hangup" },
};

// Reachable from any non-terminal stage.
export const UNIVERSAL_EXITS = ["dnc", "hangup", "callback"];

export const isTerminal = (stage) => Boolean(STAGES[stage]?.terminal);

export function canTransition(from, to) {
  if (!STAGES[to] || isTerminal(from)) return false;
  return UNIVERSAL_EXITS.includes(to) || STAGES[from].next.includes(to);
}

// Facts the bot captures; the map shows them on the prospect card and the
// handoff writes them to the CRM lead record.
// serverOnly facts are set by the server after a check (address match, vault
// write, quote), never by the bot's save_facts, so the gates can trust them.
export const FACTS = {
  first_name: { label: "Name", group: "identity" },
  last_name: { label: "Last name", group: "identity" },
  gender: { label: "Gender", group: "identity" },
  state: { label: "State", group: "identity" },
  coverage_for: { label: "Coverage for", group: "identity" },
  date_of_birth: { label: "DOB", group: "eligibility" },
  age: { label: "Age", group: "eligibility", serverOnly: true },
  income_source: { label: "Income", group: "eligibility" },
  deposit_type: { label: "Deposit", group: "eligibility" },
  ss_deposit_day: { label: "SS day", group: "eligibility" },
  marital_status: { label: "Marital status", group: "needs" },
  family: { label: "Family", group: "needs" },
  protecting: { label: "Protecting", group: "needs" },
  why_now: { label: "Why now", group: "needs" },
  current_coverage: { label: "Current coverage", group: "needs" },
  pain: { label: "Pain", group: "needs" },
  aligned: { label: "Aligned on goal", group: "needs" },
  funeral_experience: { label: "Funeral experience", group: "needs" },
  burial_or_cremation: { label: "Burial/Cremation", group: "needs" },
  face_amount: { label: "Coverage target", group: "needs" },
  case_confirmed: { label: "Case confirmed", group: "needs" },
  tobacco: { label: "Tobacco", group: "health" },
  height: { label: "Height", group: "health" },
  weight: { label: "Weight", group: "health" },
  medications: { label: "Medications", group: "health" },
  health_conditions: { label: "Conditions", group: "health" },
  tier: { label: "Tier", group: "health", serverOnly: true },
  chosen_option: { label: "Chosen plan", group: "application" },
  primary_beneficiary: { label: "Beneficiary", group: "application" },
  address: { label: "Address", group: "application", serverOnly: true },
  city: { label: "City", group: "application", serverOnly: true },
  zip: { label: "ZIP", group: "application", serverOnly: true },
  county: { label: "County", group: "application", serverOnly: true },
  address_verified: { label: "Address verified", group: "application", serverOnly: true },
  draft_date: { label: "Draft date", group: "application" },
  ssn_on_file: { label: "SSN", group: "application", serverOnly: true },
  bank_on_file: { label: "Bank", group: "application", serverOnly: true },
};

// A complete application: everything the licensed agent needs to submit. If the
// prospect won't give a piece, the call ends as "transferred" (290) instead.
export const HANDOFF_REQUIRES = ["chosen_option", "primary_beneficiary", "address_verified", "draft_date", "ssn_on_file", "bank_on_file"];

// Every change to a call is one of these events. The call state is a pure fold
// over the event log, so a live call, a replay and a simulation are the same code.
//
//   { type: "call_started", callId, at, lead: { uid?, name? } }
//   { type: "stage",        at, to, mood?: "warm"|"neutral"|"cold", note? }
//   { type: "fact",         at, key, value }
//   { type: "quote",        at, tier, options: [{ carrier, product, face, monthly }] }
//   { type: "objection",    at, kind, resolved }
//   { type: "transcript",   at, speaker: "bot"|"prospect", text }
//   { type: "call_ended",   at, reason }
