import { readFileSync } from "node:fs";
import { config } from "./config.mjs";

// Rate table schema: see README ("Loading your own rates").
const TABLE = JSON.parse(readFileSync(config.rateTable, "utf8"));

export const QUOTE_FACES = [7500, 10000, 15000];

export const annual = (rate, face, table = TABLE) => Math.round((rate * face / 1000 + table.policyFeeAnnual) * 100) / 100;
export const monthly = (rate, face, table = TABLE) => Math.round(annual(rate, face, table) * table.modalMonthly * 100) / 100;

// Three options around the target, the middle one being the prospect's own number.
function facesAround(target) {
  const t = Math.min(Math.max(Math.round(target / 2500) * 2500, 5000), 25000);
  return [...new Set([Math.max(t - 2500 * Math.ceil(t / 10000), 2500), t, t + 5000])];
}

export function quote({ age, gender, tobacco, faceAmount }) {
  const row = TABLE.rates[age];
  if (!row) return { ok: false, reason: `Age ${age} is outside the rate table (${Object.keys(TABLE.rates)[0]}-${Object.keys(TABLE.rates).at(-1)})` };
  const rate = row[gender === "F" ? "F" : "M"][tobacco ? "T" : "N"];
  const options = facesAround(faceAmount || 10000).map((face) => ({
    carrier: config.carrierName,
    product: TABLE.plan,
    face,
    monthly: monthly(rate, face),
    annual: annual(rate, face),
  }));
  return { ok: true, tier: "LEVEL", options };
}
