// Checks a partial settings update against the schema. Input is untrusted (it comes
// from the Settings page); output is ready for store.save().
import { settingFor } from "./settings-schema.mjs";
import { toE164, isLoopbackHost, config } from "./config.mjs";

const LENGTH_CAP = { text: 500, textarea: 8000, secret: 4096, url: 500, phones: 2000 };
const PHONE_HELP = "Enter a 10-digit US number, like (512) 555-0100.";

class Invalid extends Error {}
const fail = (message) => { throw new Invalid(message); };

const phone = (v) => toE164(v) ?? fail(PHONE_HELP);

// Each parser takes the trimmed, non-empty input and returns the string to store.
const PARSE = {
  secret: (v) => v,
  text: (v) => v,
  textarea: (v) => v,
  phone,
  phones: (v) => v.split(",").map((s) => s.trim()).filter(Boolean)
    .map((n) => toE164(n) ?? fail(`"${n}" is not a phone number. Separate numbers with commas, like (512) 555-0100, (512) 555-0101.`)).join(","),
  url: (v) => {
    let u;
    try { u = new URL(v); } catch { fail("Enter a full address that starts with https://"); }
    if (u.protocol !== "https:") fail("The address must start with https:// so Twilio can reach it securely.");
    return v.replace(/\/+$/, "");
  },
  number: (v, row) => {
    const n = Number(v);
    if (!Number.isFinite(n)) fail("Enter a number.");
    if (row.min !== undefined && n < row.min) fail(`Use ${row.min} or more.`);
    if (row.max !== undefined && n > row.max) fail(`Use ${row.max} or less.`);
    return String(n);
  },
  select: (v, row) => (row.options.some((o) => o.value === v) ? v : fail("Pick one of the listed choices.")),
  bool: (v) => (v === "true" || v === "false" ? v : fail("Choose on or off.")),
};

// Extra per-key rules applied to the parsed value.
const CHECKS = {
  SCRIPT_OPENER_REQUESTED_INFO: (v) => recordingNotice(v),
  SCRIPT_OPENER_TV_CALLBACK: (v) => recordingNotice(v),
  SCRIPT_OPENER_INBOUND: (v) => recordingNotice(v),
};
function recordingNotice(v) {
  if (!/recorded/i.test(v)) fail("Calls are recorded, so the opener must say so. Include the word \"recorded\", for example \"this call is recorded\".");
}

function editable(row, key, store) {
  if (!row) return "Unknown setting.";
  if (row.uiReadOnly) return "This setting can't be changed here.";
  if (store.isLocked(key)) return "This comes from the server environment. Change it there.";
  return null;
}

function parse(row, input) {
  const v = String(input).trim();
  const cap = LENGTH_CAP[row.type];
  if (cap && v.length > cap) fail(`Keep this under ${cap} characters.`);
  if (row.minLength && v.length < row.minLength) fail(`Use at least ${row.minLength} characters.`);
  const parsed = PARSE[row.type](v, row);
  CHECKS[row.key]?.(parsed);
  return parsed;
}

// body: { values: { KEY: string | number | boolean }, clear: [KEY] }
// A secret sent as "" means "no change"; any other setting sent as "" goes back to its default.
// Returns { values, clear, errors } where errors is { KEY: message } and empty when valid.
export function validateUpdate(body, store) {
  const values = {}, clear = new Set(), errors = {};
  const input = body?.values ?? {};
  if (typeof input !== "object" || Array.isArray(input)) return { values, clear: [], errors: { _: "values must be an object." } };
  if (body?.clear !== undefined && !Array.isArray(body.clear)) return { values, clear: [], errors: { _: "clear must be a list of setting names." } };

  for (const key of body?.clear ?? []) {
    const reason = editable(settingFor(key), key, store);
    if (reason) errors[key] = reason; else clear.add(key);
  }
  for (const [key, raw] of Object.entries(input)) {
    const row = settingFor(key);
    const reason = editable(row, key, store);
    if (reason) { errors[key] = reason; continue; }
    if (!["string", "number", "boolean"].includes(typeof raw)) { errors[key] = "Send text, a number, or true or false."; continue; }
    if (String(raw).trim() === "") {
      if (row.type !== "secret") clear.add(key);
      continue;
    }
    try { values[key] = parse(row, raw); clear.delete(key); } catch (err) {
      if (!(err instanceof Invalid)) throw err;
      errors[key] = err.message;
    }
  }
  if (clear.has("DASHBOARD_TOKEN") && !isLoopbackHost(config.host))
    errors.DASHBOARD_TOKEN = "This server is reachable from other machines, so it needs a dashboard password.";
  return { values, clear: [...clear], errors };
}
