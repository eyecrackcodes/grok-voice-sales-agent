// Optional CRM adapter for a hosted CRM with a tool-call HTTP API (Digital
// Senior Benefits). Select it with CRM_PROVIDER=dsb. It writes a finished call
// into the lead record so the licensed agent opens a complete application. SSN
// goes only to the CRM's encrypted field and is never written mid-call. Bank
// details stay in the vault unless CRM_BANK_IN_NOTE=true, which puts them in the
// handoff note in plain text; otherwise the note has the bank name and last 4.
// Status ids and field names are that CRM's own; a different CRM needs its own
// adapter (see src/crm/none.mjs).
// Env: DSB_BASE, DSB_CRM_MCP (use a least-privilege token), DSB_QUEUE_STATUS,
// CRM_CARRIER_ID, CRM_PRODUCT_ID.
import { env } from "../../scripts/env.mjs";
import { vaultGet, vaultMasked } from "../vault.mjs";
import { config } from "../config.mjs";
import { MIN_LEAD_DAYS } from "../draft-date.mjs";
import { MILESTONES, isNameMismatch, mismatchText } from "../progress.mjs";

async function callTool(name, args = {}) {
  const res = await fetch(`${env("DSB_BASE").replace(/\/+$/, "")}/v1/tools/call`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("DSB_CRM_MCP")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, arguments: args }),
  });
  return res.json();
}

const FINAL_EXPENSE = "570";
const ABBR = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming" };
const stateName = (s) => ABBR[String(s ?? "").trim().toUpperCase()] ?? String(s ?? "").trim();

function mdy(value) {
  const s = String(value ?? "");
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[2].padStart(2, "0")}/${m[3].padStart(2, "0")}/${m[1]}`;
  m = s.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  return m ? `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${m[3]}` : null;
}

// "Karen Miller (daughter) 50%; Lisa Miller (daughter) 50%" -> CRM beneficiary rows, equal shares by default.
export function parseBeneficiaries(text) {
  const parts = String(text ?? "").split(/;|\band\b/i).map((p) => p.trim()).filter(Boolean);
  const rows = parts.map((p) => {
    const pct = p.match(/(\d{1,3})\s*%/)?.[1];
    const rel = p.match(/\(([^)]+)\)/)?.[1] ?? p.match(/,\s*([a-z ]+)$/i)?.[1] ?? "";
    const name = p.replace(/\([^)]*\)/, "").replace(/\d{1,3}\s*%/, "").replace(/,\s*[a-z ]+$/i, "").trim();
    return { beneficiary_name: name, beneficiary_relationship: rel.trim(), share: pct ? Number(pct) : null };
  });
  const even = Math.floor(100 / Math.max(rows.length, 1));
  return rows.map((r, i) => ({
    beneficiary_name: r.beneficiary_name,
    beneficiary_relationship: r.beneficiary_relationship,
    beneficiary_ownership: String(r.share ?? (i === 0 ? 100 - even * (rows.length - 1) : even)),
  }));
}

function chosenOption(state) {
  const options = state.quote?.options ?? [];
  const said = String(state.facts.chosen_option ?? "").replace(/,/g, "");
  return options.find((o) => said.includes(String(o.face)) || said.includes(String(o.monthly))) ?? null;
}

// The case summary shared by the handoff note and the mid-call progress notes.
// secureLine goes after the address; only the handoff has one.
function summaryLines(state, secureLine) {
  const f = state.facts;
  const o = chosenOption(state);
  const objections = state.objections.map((x) => `${x.kind}${x.afterPrice ? " (after price)" : ""}: ${x.resolved === true ? "overcome" : x.resolved === false ? "not overcome" : "open"}`);
  return [
    o ? `Plan: ${o.carrier} ${o.product}, $${o.face.toLocaleString()} face, $${o.monthly}/mo` : `Plan: ${f.chosen_option ?? "not chosen"}`,
    `Draft: ${f.draft_date ?? "?"} (SS arrives ${f.ss_deposit_day ?? "?"}) | Beneficiary: ${f.primary_beneficiary ?? "?"}`,
    `Address: ${[f.address, f.city, f.zip].filter(Boolean).join(", ") || "not captured"}${f.address_verified ? " (Census-matched)" : ""}`,
    secureLine,
    `Why they're buying: protecting ${f.protecting ?? "?"}; ${f.pain ?? ""}${f.why_now ? ` | Why now: ${f.why_now}` : ""}`,
    `Health: tobacco ${f.tobacco ?? "?"}; ${f.height ?? "?"}, ${f.weight ?? "?"}; meds ${f.medications ?? "none"}; ${f.health_conditions ?? ""}`,
    objections.length ? `Objections: ${objections.join("; ")}` : "Objections: none",
  ].filter(Boolean);
}

// Full numbers only when the owner chose to keep them in the CRM note; the default is what the
// agent needs to recognize the account, not to use it.
function bankLine(masked, bank = {}) {
  if (!masked.bank) return "Bank: not captured";
  if (!config.crmBankInNote || !bank.routing || !bank.account)
    return `Bank: ${masked.bank}${masked.routingVerified ? ", routing verified" : ""}`;
  return `Bank draft: ${bank.bank ?? "bank name not found"}${bank.accountType ? `, ${bank.accountType}` : ""} | Routing ${bank.routing} (verified) | Account ${bank.account}`;
}

export function handoffNote(state, { status, masked, bank }) {
  return [
    `AI call handoff (${config.botName}, Grok Voice) - ${status === 300 ? "complete application, ready to submit" : "live transfer, agent to finish"}`,
    ...summaryLines(state, `SSN: ${masked.ssn ? `${masked.ssn} in encrypted SSN field` : "not captured"} | ${bankLine(masked, bank)}`),
    `Call ${state.callId}`,
  ].join("\n");
}

export function progressNote(state, label) {
  return [`AI call in progress (${config.botName}): ${label}`, ...summaryLines(state), `Call ${state.callId}`].join("\n");
}

export function nameMismatchNote(state, crmFirstName) {
  return [mismatchText(state, crmFirstName), ...summaryLines(state), `Call ${state.callId}`].join("\n");
}

async function must(name, args) {
  const r = await callTool(name, args);
  if (!r.success) throw new Error(`${name}: ${r.error ?? JSON.stringify(r).slice(0, 200)}`);
  return r.data;
}

// When the lead belongs to someone else, leave a note and nothing else.
async function guardName({ leadUid, lead, state }) {
  if (!isNameMismatch(state, lead.first_name)) return null;
  await must("leads_add_note", { lead_uid: leadUid, note: nameMismatchNote(state, lead.first_name) });
  return { nameMismatch: true, fieldsWritten: [], ssnWritten: false, statusChanged: false };
}

const finalExpensePolicy = (lead) => [...(lead.policies ?? [])].reverse().find((p) => String(p.policy_type) === FINAL_EXPENSE);

// Everything the call has captured so far, as CRM policy fields. Never the SSN.
export function leadFields(state, states) {
  const f = state.facts;
  const stateId = states.find((s) => s.name.toLowerCase() === stateName(f.state).toLowerCase())?.id;
  const o = chosenOption(state);
  const product = o && config.crmCarrierId && config.crmProductId ? { carrier_id: config.crmCarrierId, product_id: config.crmProductId } : null;
  return Object.fromEntries(Object.entries({
    first_name: f.first_name, last_name: f.last_name, date_of_birth: mdy(f.date_of_birth),
    gender: f.gender ? (/^f/i.test(f.gender) ? "Female" : "Male") : null,
    tobacco: f.tobacco == null ? null : (/^(no|false|never|non)/i.test(f.tobacco) ? "No" : "Yes"),
    height: f.height, weight: f.weight, medications: f.medications, health_conditions: f.health_conditions,
    income_source: f.income_source, address: f.address, city: f.city, zip: f.zip, resident_county: f.county,
    state: stateId,
    carrier_id: product?.carrier_id, product_id: product?.product_id,
    face_amount: o?.face, modal_premium: o?.monthly, annual_premium: o?.annual, mode: o ? "Monthly" : null,
    premium_draft_date: nextDraftDate(f.draft_date) ?? nextDraftDate(f.ss_deposit_day),
    primary_beneficiary: f.primary_beneficiary ? parseBeneficiaries(f.primary_beneficiary) : null,
  }).filter(([, v]) => v != null && v !== ""));
}

async function syncHandoff({ leadUid, state, status }) {
  const lead = await must("leads_get", { lead_uid: leadUid });
  const mismatch = await guardName({ leadUid, lead, state });
  if (mismatch) return { ...mismatch, status };
  const policy = finalExpensePolicy(lead);
  if (!policy) throw new Error("Lead has no final expense policy row to fill");
  const vault = vaultGet(state.callId);
  const masked = vaultMasked(state.callId);
  const fields = leadFields(state, await must("states_list", {}));

  await must("leads_update", { lead_uid: leadUid, policy_id: policy.id, ...fields });
  if (vault.ssn) await must("leads_update", { lead_uid: leadUid, ssn: vault.ssn });
  await must("leads_add_note", { lead_uid: leadUid, note: handoffNote(state, { status, masked, bank: vault }) });
  const testLead = isTestLead(policy);
  if (!testLead) await must("leads_change_status", { lead_uid: leadUid, policy_id: policy.id, status });
  return { policyId: policy.id, fieldsWritten: Object.keys(fields), ssnWritten: Boolean(vault.ssn), bankInNote: config.crmBankInNote && Boolean(vault.routing && vault.account), status, statusChanged: !testLead };
}

// A mid-call write: the fields captured so far plus a note. No status change and no SSN,
// so a call that dies here leaves the lead where it was.
async function syncProgress({ leadUid, state, stage }) {
  const lead = await must("leads_get", { lead_uid: leadUid });
  const mismatch = await guardName({ leadUid, lead, state });
  if (mismatch) return { ...mismatch, stage };
  const policy = finalExpensePolicy(lead);
  if (!policy) throw new Error("Lead has no final expense policy row to fill");
  const fields = leadFields(state, await must("states_list", {}));
  await must("leads_update", { lead_uid: leadUid, policy_id: policy.id, ...fields });
  await must("leads_add_note", { lead_uid: leadUid, note: progressNote(state, MILESTONES[stage]) });
  return { policyId: policy.id, stage, fieldsWritten: Object.keys(fields) };
}

// Test calls fill the record and leave a note, but never move a lead out of
// "Withdrawn - Test Lead", so test leads stay out of queues and reports.
const TEST_LEAD_STATUS = 620;
const isTestLead = (policy) => Number(policy?.status) === TEST_LEAD_STATUS;

const ORDINAL = { first: 1, second: 2, third: 3, fourth: 4, "1st": 1, "2nd": 2, "3rd": 3, "4th": 4 };
const WEEKDAY = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// "11/18/2026", "the 3rd", or "third Wednesday" -> the first such date at least MIN_LEAD_DAYS days out, as MM/DD/YYYY.
// An exact date that has already passed is null, so the caller falls back to the deposit-day rule.
export function nextDraftDate(text, today = new Date()) {
  const direct = mdy(text);
  if (direct) {
    const [m, d, y] = direct.split("/").map(Number);
    return new Date(y, m - 1, d) >= new Date(today.getFullYear(), today.getMonth(), today.getDate()) ? direct : null;
  }
  const s = String(text ?? "").toLowerCase();
  const earliest = new Date(today.getFullYear(), today.getMonth(), today.getDate() + MIN_LEAD_DAYS);
  const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
  const nth = s.match(/\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  for (let k = 0; k < 3; k++) {
    const y = today.getFullYear(), mo = today.getMonth() + k;
    let d = null;
    if (nth) {
      const first = new Date(y, mo, 1);
      const offset = (WEEKDAY.indexOf(nth[2]) - first.getDay() + 7) % 7;
      d = new Date(y, mo, 1 + offset + 7 * (ORDINAL[nth[1]] - 1));
    } else {
      const day = Number(s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/)?.[1]);
      if (day >= 1 && day <= 28) d = new Date(y, mo, day);
    }
    if (d && d >= earliest) return fmt(d);
  }
  return null;
}

const OUTCOME_STATUS = { callback: 50, lost: 420, not_qualified: 440, dnc: 500 };

function outcomeNote(state) {
  const f = state.facts;
  const t = state.transcript.slice(-6).map((x) => `${x.speaker === "bot" ? config.botName : f.first_name ?? "Prospect"}: ${x.text}`).join("\n");
  return [
    `AI callback (${config.botName}, Grok Voice): ${state.outcome}${state.stage === "callback" ? " - prospect asked for a callback" : ""}`,
    `Reached: ${state.trail.map((x) => x.stage).filter((s) => s !== "dialing").join(" > ")}`,
    f.protecting || f.pain ? `Case: protecting ${f.protecting ?? "?"}; ${f.pain ?? ""}` : null,
    state.quote ? `Quoted: ${state.quote.options.map((o) => `$${o.face.toLocaleString()} @ $${o.monthly}/mo`).join(", ")}` : null,
    state.objections.length ? `Objections: ${state.objections.map((o) => o.kind).join(", ")}` : null,
    t ? `Last words:\n${t}` : null,
    `Call ${state.callId}`,
  ].filter(Boolean).join("\n");
}

// Every non-handoff ending: a note, the matching status, and the DNC flag when asked.
async function syncOutcome({ leadUid, state }) {
  const lead = await must("leads_get", { lead_uid: leadUid });
  const mismatch = await guardName({ leadUid, lead, state });
  if (mismatch) return { ...mismatch, status: null };
  const policy = finalExpensePolicy(lead);
  await must("leads_add_note", { lead_uid: leadUid, note: outcomeNote(state) });
  if (state.outcome === "dnc") await must("leads_change_dnc", { lead_uid: leadUid, dnc: true });
  let status = OUTCOME_STATUS[state.outcome] ?? null;
  if (state.outcome === "hangup") status = state.pricePresented ? 110 : state.trail.some((t) => t.stage === "discovery") ? 80 : null;
  const change = status != null && policy && !isTestLead(policy);
  if (change) await must("leads_change_status", { lead_uid: leadUid, policy_id: policy.id, status });
  return { status, statusChanged: change };
}

// ---- adapter interface ----

let statesCache = null;
const stateNames = async () => (statesCache ??= await must("states_list", {}));

async function normalize(l) {
  const states = await stateNames();
  return { id: l.lead_uid, first_name: l.first_name ?? "", last_name: l.last_name ?? "", phone: l.mobile || l.phone || "",
    state: states.find((x) => String(x.id) === String(l.state))?.name ?? "", timezone: l.timezone || "", dnc: Boolean(l.dnc), created_at: l.create_date ?? "" };
}

// The CRM stamps create_date in UTC as "2026-10-18 19:29:10".
const createdAt = (lead) => Date.parse(`${String(lead.create_date ?? "").replace(" ", "T")}Z`);

// Newest first. With recentMinutes, only leads created that recently (a minute of clock skew allowed).
export function newestLeads(leads, { recentMinutes, now = Date.now() } = {}) {
  return leads
    .filter((l) => !recentMinutes || (now - createdAt(l) <= recentMinutes * 60000 && now - createdAt(l) >= -60000))
    .sort((a, b) => (createdAt(b) || 0) - (createdAt(a) || 0));
}

export async function findByPhone(phone, { recentMinutes } = {}) {
  const digits = String(phone ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (digits.length !== 10) return null;
  const r = await callTool("leads_search", { search: digits, limit: 5 });
  if (!r.success) throw new Error(`leads_search: ${r.error}`);
  const rows = r.data?.leads ?? r.data?.data ?? (Array.isArray(r.data) ? r.data : []);
  const lead = newestLeads(rows, { recentMinutes })[0];
  return lead ? normalize(lead) : null;
}

export async function listQueue() {
  const r = await callTool("leads_search", { status: process.env.DSB_QUEUE_STATUS || "55", limit: 200, sort: "time_asc" });
  if (!r.success) throw new Error(`leads_search: ${r.error}`);
  const leads = r.data.leads ?? r.data.data ?? (Array.isArray(r.data) ? r.data : []);
  return Promise.all(leads.map(normalize));
}

export async function getLead(id) {
  return normalize(await must("leads_get", { lead_uid: id }));
}

// status: "complete" (application finished, ready to submit) or "transfer" (agent finishes).
export const writeHandoff = ({ lead, state, status }) => syncHandoff({ leadUid: lead.id, state, status: status === "complete" ? 300 : 290 });
export const writeOutcome = ({ lead, state }) => syncOutcome({ leadUid: lead.id, state });
export const writeProgress = ({ lead, state, stage }) => syncProgress({ leadUid: lead.id, state, stage });
export const addNote = (lead, text) => must("leads_add_note", { lead_uid: lead.id, note: text });
