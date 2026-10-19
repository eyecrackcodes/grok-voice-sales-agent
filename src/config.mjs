// Single source for business settings. Everything reads env with a safe default,
// so a fresh clone runs in demo mode: it can only dial numbers on DIAL_ALLOWLIST.
import "../scripts/env.mjs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { defaultOf } from "./settings-schema.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const DEFAULT_AGENT = "your licensed agent";

// Settings can change while the server runs (the Settings page writes them into
// process.env), so every field is read at the moment it is used, never cached.
const raw = (key) => {
  const v = process.env[key];
  return v === undefined || v === "" ? defaultOf(key) : v;
};
const str = (key) => String(raw(key) ?? "");
const num = (key) => (raw(key) === undefined || raw(key) === "" ? null : Number(raw(key)));
const bool = (key) => raw(key) === true || raw(key) === "true";

export const config = {
  get companyName() { return str("COMPANY_NAME"); },
  get botName() { return str("BOT_NAME"); },
  get agentName() { return str("AGENT_NAME") || DEFAULT_AGENT; },
  get voice() { return str("VOICE"); },
  get voiceModel() { return str("VOICE_MODEL"); },
  get carrierName() { return str("CARRIER_NAME"); },
  get carrierBlurb() { return str("CARRIER_BLURB"); },
  get aiDisclosure() { return bool("AI_DISCLOSURE"); },
  get rateTable() { const r = str("RATE_TABLE"); return isAbsolute(r) ? r : resolve(ROOT, r); },
  get crmProvider() { return str("CRM_PROVIDER").toLowerCase(); },
  get crmCarrierId() { return num("CRM_CARRIER_ID"); },
  get crmProductId() { return num("CRM_PRODUCT_ID"); },
  get crmBankInNote() { return bool("CRM_BANK_IN_NOTE"); },
  get agentTransferNumber() { return str("AGENT_TRANSFER_NUMBER"); },
  get transferMode() { return str("TRANSFER_MODE"); },
  get maxCallMinutes() { return num("MAX_CALL_MINUTES"); },
  // Accept "(512) 555-0100" or "5125550100" as well as +15125550100.
  get dialAllowlist() { return list(raw("DIAL_ALLOWLIST")).map((n) => toE164(n) ?? n); },
  get consentConfirmed() { return bool("CONSENT_CONFIRMED"); },
  get dashboardToken() { return str("DASHBOARD_TOKEN"); },
  get host() { return process.env.HOST || "127.0.0.1"; },
  get port() { return Number(process.env.PORT) || 4319; },
  dialer: {
    get source() { return str("DIALER_SOURCE"); },
    get lines() { return num("DIALER_LINES"); },
    get maxAttempts() { return num("DIALER_MAX_ATTEMPTS"); },
    get gapMinutes() { return num("DIALER_GAP_MINUTES"); },
    get maxCallsPerDay() { return num("DIALER_MAX_CALLS_PER_DAY"); },
    get windowStart() { return num("DIALER_WINDOW_START"); },
    get windowEnd() { return num("DIALER_WINDOW_END"); },
  },
  inbound: {
    get enabled() { return bool("INBOUND_ENABLED"); },
    get fallbackNumber() { return str("INBOUND_FALLBACK_NUMBER"); },
    get hours() { return [num("INBOUND_HOUR_START"), num("INBOUND_HOUR_END")]; },
    get tz() { return str("INBOUND_TZ"); },
    get maxPerDay() { return num("INBOUND_MAX_PER_DAY"); },
    get maxActive() { return num("INBOUND_MAX_ACTIVE"); },
    get match() { return str("INBOUND_MATCH"); },
    get acceptDigits() { return str("INBOUND_ACCEPT_DIGITS"); },
  },
  script: {
    get openerRequestedInfo() { return str("SCRIPT_OPENER_REQUESTED_INFO"); },
    get openerTvCallback() { return str("SCRIPT_OPENER_TV_CALLBACK"); },
    get openerInbound() { return str("SCRIPT_OPENER_INBOUND"); },
    get extra() { return str("SCRIPT_EXTRA"); },
  },
};

export const agentIsNamed = () => config.agentName !== DEFAULT_AGENT;

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
