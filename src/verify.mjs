// Checks run while the prospect is still on the line, so mistakes get fixed by
// reading the corrected value back instead of by the agent days later.

const digits = (s) => String(s ?? "").replace(/\D/g, "");

// ABA routing check digit: 3-7-1 weights over the 9 digits must sum to a multiple of 10.
export function abaChecksumOk(routing) {
  const d = digits(routing);
  if (d.length !== 9) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  return [...d].reduce((sum, c, i) => sum + Number(c) * w[i], 0) % 10 === 0;
}

const routingCache = new Map();

// Only the routing number leaves the machine; it identifies the bank, not the customer.
export async function lookupRouting(routing) {
  const d = digits(routing);
  if (routingCache.has(d)) return routingCache.get(d);
  try {
    const res = await fetch(`https://bankrouting.io/api/v1/aba/${d}`, { signal: AbortSignal.timeout(4000) });
    const j = await res.json();
    const hit = j.status === "success" && j.data?.bank_name ? { bank: j.data.bank_name, city: j.data.city, state: j.data.state } : null;
    routingCache.set(d, hit);
    return hit;
  } catch {
    return undefined;
  }
}

export async function checkRouting(routing) {
  const d = digits(routing);
  if (d.length !== 9) return { ok: false, reason: `A routing number has 9 digits; I heard ${d.length}.` };
  if (!abaChecksumOk(d)) return { ok: false, reason: "That routing number doesn't pass the bank check digit, so a digit is likely off. Ask them to read it again from a check." };
  const hit = await lookupRouting(d);
  if (hit === null) return { ok: false, reason: "That routing number isn't in the bank directory. Ask them to read it again from a check." };
  return { ok: true, routing: d, bank: hit?.bank ?? null, lookedUp: hit !== undefined };
}

export function checkAccount(account) {
  const d = digits(account);
  if (d.length < 4 || d.length > 17) return { ok: false, reason: `Account numbers are 4 to 17 digits; I heard ${d.length}.` };
  return { ok: true, account: d };
}

// Structural validity only; real identity verification needs SSA consent-based services.
export function checkSsn(ssn) {
  const d = digits(ssn);
  if (d.length !== 9) return { ok: false, reason: `A Social Security number has 9 digits; I heard ${d.length}.` };
  const [area, group, serial] = [d.slice(0, 3), d.slice(3, 5), d.slice(5)];
  if (area === "000" || area === "666" || area[0] === "9") return { ok: false, reason: "That number can't be a valid SSN (the first three digits are never issued). Ask them to repeat it." };
  if (group === "00" || serial === "0000") return { ok: false, reason: "That number can't be a valid SSN (it contains an all-zero group). Ask them to repeat it." };
  return { ok: true, ssn: d };
}

// US Census geocoder: free, no key. It standardizes and finds the county but
// can't confirm unit numbers or deliverability the way USPS can.
export async function standardizeAddress({ street, city, state, zip }) {
  const line = [street, city, state, zip].filter(Boolean).join(", ");
  const url = `https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=${encodeURIComponent(line)}`
    + "&benchmark=Public_AR_Current&vintage=Current_Current&layers=Counties&format=json";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const m = (await res.json()).result?.addressMatches?.[0];
    if (!m) return { ok: false, reason: "That address didn't match any mailing address. Read it back and ask them to spell the street name and confirm the ZIP." };
    const c = m.addressComponents;
    const unit = String(street ?? "").match(/\b(apt|apartment|unit|ste|suite|lot|#)\s*\.?\s*[\w-]+/i)?.[0] ?? null;
    return {
      ok: true,
      matched: m.matchedAddress,
      street: m.matchedAddress.split(",")[0] + (unit ? ` ${unit.toUpperCase()}` : ""),
      city: c.city, state: c.state, zip: c.zip,
      county: m.geographies?.Counties?.[0]?.NAME ?? null,
      unitNote: unit ? "Unit number kept as spoken; the Census match can't confirm units." : null,
    };
  } catch {
    return { ok: false, unavailable: true, reason: "The address check is unavailable right now. Read the address back carefully and confirm each part." };
  }
}
