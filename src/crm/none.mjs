// Default CRM adapter: no external system. Leads come from data/leads.csv
// (columns id, first_name, last_name, phone, state, timezone, dnc) and every
// handoff and outcome is appended to data/outcomes.jsonl. SSN and bank details
// are never written here, only the masked values the call state already holds.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { vaultMasked } from "../vault.mjs";

// CRM_DATA_DIR relocates leads.csv and outcomes.jsonl (the tests use it); the example file always ships in data/.
const DATA = process.env.CRM_DATA_DIR ? pathToFileURL(`${process.env.CRM_DATA_DIR}/`) : new URL("../../data/", import.meta.url);
const LEADS = new URL("leads.csv", DATA);
const EXAMPLE = new URL("../../data/leads.example.csv", import.meta.url);
const OUTCOMES = new URL("outcomes.jsonl", DATA);

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  const [head = [], ...body] = rows;
  const keys = head.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

const truthy = (v) => /^(true|yes|1|y)$/i.test(String(v ?? ""));

function readOutcomes() {
  return existsSync(OUTCOMES) ? readFileSync(OUTCOMES, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function loadLeads() {
  mkdirSync(DATA, { recursive: true });
  if (!existsSync(LEADS)) {
    copyFileSync(EXAMPLE, LEADS);
    console.log("[crm:none] created data/leads.csv from data/leads.example.csv");
  }
  // Someone who asked not to be called stays blocked even if the CSV row says otherwise.
  const dnc = new Set(readOutcomes().filter((o) => o.type === "outcome" && o.outcome === "dnc").map((o) => o.leadId));
  return parseCsv(readFileSync(LEADS, "utf8")).filter((r) => r.id)
    .map((r) => ({ id: r.id, first_name: r.first_name, last_name: r.last_name, phone: r.phone, state: r.state, timezone: r.timezone, dnc: truthy(r.dnc) || dnc.has(r.id) }));
}

export async function listQueue() { return loadLeads(); }
export async function getLead(id) { return loadLeads().find((l) => l.id === id) ?? null; }

// Free-text facts are already digit-masked by the session; this is the second line of defense.
const scrub = (v) => (typeof v === "string" ? v.replace(/\d(?:[\s-]?\d){6,}/g, "[#]") : v);

function append(record) {
  mkdirSync(DATA, { recursive: true });
  appendFileSync(OUTCOMES, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

function summary(lead, state) {
  const m = vaultMasked(state.callId);
  const facts = Object.fromEntries(Object.entries(state.facts ?? {}).filter(([k]) => !/^(ssn|routing|account)/.test(k)).map(([k, v]) => [k, scrub(v)]));
  return { leadId: lead.id, callId: state.callId, outcome: state.outcome, stage: state.stage, facts,
    ssn: m.ssn, bank: m.bank, quote: state.quote?.options ?? null,
    objections: (state.objections ?? []).map((o) => ({ kind: o.kind, resolved: o.resolved ?? null })),
    lastWords: (state.transcript ?? []).slice(-6).map((t) => ({ speaker: t.speaker, text: scrub(t.text) })) };
}

export async function writeHandoff({ lead, state, status }) {
  append({ type: "handoff", status, ...summary(lead, state) });
  return { file: "data/outcomes.jsonl", status };
}

export async function writeOutcome({ lead, state }) {
  append({ type: "outcome", ...summary(lead, state) });
  return { file: "data/outcomes.jsonl" };
}

export async function addNote(lead, text) {
  append({ type: "note", leadId: lead.id, text: scrub(text) });
}
