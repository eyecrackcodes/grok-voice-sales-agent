// Single source for business settings. Everything reads env with a safe default,
// so a fresh clone runs in demo mode: it can only dial numbers on DIAL_ALLOWLIST.
import "../scripts/env.mjs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

const e = process.env;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const DEFAULT_AGENT = "your licensed agent";

export const config = {
  companyName: e.COMPANY_NAME || "Acme Final Expense",
  botName: e.BOT_NAME || "Sarah",
  agentName: e.AGENT_NAME || DEFAULT_AGENT,
  voice: e.VOICE || "eve",
  carrierName: e.CARRIER_NAME || "Sample Carrier",
  carrierBlurb: e.CARRIER_BLURB || "a sample carrier used for this demo",
  rateTable: isAbsolute(e.RATE_TABLE || "") ? e.RATE_TABLE : resolve(ROOT, e.RATE_TABLE || "src/rates/sample-level-plan.json"),
  crmProvider: (e.CRM_PROVIDER || "none").toLowerCase(),
  crmCarrierId: e.CRM_CARRIER_ID ? Number(e.CRM_CARRIER_ID) : null,
  crmProductId: e.CRM_PRODUCT_ID ? Number(e.CRM_PRODUCT_ID) : null,
  agentTransferNumber: e.AGENT_TRANSFER_NUMBER || "",
  // Accept "(512) 555-0100" or "5125550100" as well as +15125550100.
  dialAllowlist: list(e.DIAL_ALLOWLIST).map((n) => toE164(n) ?? n),
  consentConfirmed: e.CONSENT_CONFIRMED === "true",
  dashboardToken: e.DASHBOARD_TOKEN || "",
  host: e.HOST || "127.0.0.1",
  port: Number(e.PORT) || 4319,
};

export const agentIsNamed = config.agentName !== DEFAULT_AGENT;

export const isLoopbackHost = (host) => /^(localhost|::1|\[::1\]|127(\.\d{1,3}){3})$/i.test(String(host));

// Where this process's own server can be reached by its own scripts.
export const localBase = () => {
  const h = ["0.0.0.0", "::", "[::]"].includes(config.host) ? "127.0.0.1" : config.host;
  return `http://${h.includes(":") && !h.startsWith("[") ? `[${h}]` : h}:${config.port}`;
};
export const localAuthHeaders = () => (config.dashboardToken ? { Authorization: `Bearer ${config.dashboardToken}` } : {});

let consentWarned = false;
export function warnConsentOnce(log = console.warn) {
  if (!config.consentConfirmed || consentWarned) return;
  consentWarned = true;
  log("[safety] CONSENT_CONFIRMED=true: the allowlist is off. You are responsible for TCPA prior express written consent, "
    + "National and internal DNC scrubbing, state calling hours and recording-consent law. See COMPLIANCE.md.");
}

// Demo-mode gate. Returns { ok, reason }; callers refuse the call when not ok.
export function checkDial(e164, { log = console.error } = {}) {
  if (config.consentConfirmed) { warnConsentOnce(); return { ok: true }; }
  if (config.dialAllowlist.includes(e164)) return { ok: true };
  const reason = `REFUSED to dial ${e164.slice(0, -4).replace(/\d/g, "*")}${e164.slice(-4)}: demo mode is on and the number is not in DIAL_ALLOWLIST. `
    + "Add your own number to DIAL_ALLOWLIST, or set CONSENT_CONFIRMED=true only if you hold consent for every number you dial (see COMPLIANCE.md).";
  log(`[safety] ${reason}`);
  return { ok: false, reason };
}

export function toE164(value) {
  const d = String(value ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `+1${d}` : null;
}
