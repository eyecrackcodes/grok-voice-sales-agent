// All draft-date math lives here: the model misdated a caller's "Monday the 2nd" and misnamed a weekday,
// so it only reads back what the server computed. Dates are UTC date-only Date values.
import { parseDob } from "./dob.mjs";

const DAY_MS = 86400000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const FIXED_HOLIDAYS = new Set(["1-1", "6-19", "7-4", "11-11", "12-25"]);
const NTH_WORD = { 2: "second", 3: "third", 4: "fourth" };

const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const addDays = (date, n) => new Date(date.getTime() + n * DAY_MS);
const pad = (n) => String(n).padStart(2, "0");

export const todayUtc = (now = new Date()) => utc(now.getFullYear(), now.getMonth() + 1, now.getDate());

function ordinal(n) {
  const v = n % 100;
  return `${n}${v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export const mdy = (date) => `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${date.getUTCFullYear()}`;
export const spoken = (date) => `${WEEKDAYS[date.getUTCDay()]}, ${MONTH_NAMES[date.getUTCMonth()]} ${ordinal(date.getUTCDate())}`;

export function ruleFromDob(dob) {
  const parsed = parseDob(dob);
  if (!parsed) return null;
  const day = parsed[2];
  if (day < 1 || day > 31) return null;
  return { kind: "wednesday", nth: day <= 10 ? 2 : day <= 20 ? 3 : 4 };
}

const ORDINALS = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4 };

export function ruleFromText(text) {
  const s = String(text ?? "").toLowerCase();
  const wed = s.match(/\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+wednesday\b/);
  if (wed) return ORDINALS[wed[1]] >= 2 ? { kind: "wednesday", nth: ORDINALS[wed[1]] } : null;
  if (/\bwednesday\b/.test(s)) return null;
  const day = s.match(/\b(first|third|1st|3rd)\b/);
  return day ? { kind: "day", day: ORDINALS[day[1]] } : null;
}

const isHoliday = (d) => FIXED_HOLIDAYS.has(`${d.getUTCMonth() + 1}-${d.getUTCDate()}`);
const isBusinessDay = (d) => d.getUTCDay() % 6 !== 0 && !isHoliday(d);

export function paymentDate(rule, year, month) {
  let d;
  if (rule.kind === "day") d = utc(year, month, rule.day);
  else {
    const first = utc(year, month, 1);
    d = utc(year, month, 1 + ((3 - first.getUTCDay() + 7) % 7) + 7 * (rule.nth - 1));
  }
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}

export function nextDraftDates(rule, today, { minLeadDays = 2, count = 2 } = {}) {
  const earliest = addDays(today, minLeadDays);
  const out = [];
  for (let k = 0; out.length < count && k < 24; k++) {
    const d = paymentDate(rule, today.getUTCFullYear(), today.getUTCMonth() + 1 + k);
    if (d >= earliest) out.push(d);
  }
  return out;
}

const MONTH_PREFIXES = MONTH_NAMES.map((m) => m.slice(0, 3).toLowerCase());

export function resolveRequested(text, today) {
  const s = String(text ?? "").toLowerCase();
  const weekday = WEEKDAYS.findIndex((w) => s.includes(w.toLowerCase()));
  let month = null, day = null, year = null;
  let m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/);
  if (m) { month = +m[1]; day = +m[2]; year = m[3] ? +m[3] : null; }
  else if ((m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/))) {
    month = MONTH_PREFIXES.indexOf(m[1]) + 1; day = +m[2];
  } else if ((m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/))) day = +m[1];
  if (!day || day > 31 || (month != null && (month < 1 || month > 12)))
    return { ok: false, error: "Could not read a date from that. Ask them which day of the month they want." };

  const valid = (y, mo) => day <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
  let date = null;
  if (year) date = valid(year, month) ? utc(year, month, day) : null;
  else {
    for (let k = 0; k < 24 && !date; k++) {
      const total = today.getUTCMonth() + k;
      const y = today.getUTCFullYear() + Math.floor(total / 12), mo = (total % 12) + 1;
      if (month != null && mo !== month) continue;
      if (valid(y, mo) && utc(y, mo, day) > today) date = utc(y, mo, day);
    }
  }
  if (!date || date <= today) return { ok: false, error: "That date does not exist or is not in the future. Ask them for another day." };
  if (weekday >= 0 && date.getUTCDay() !== weekday)
    return { ok: false, error: `${MONTH_NAMES[date.getUTCMonth()]} ${ordinal(date.getUTCDate())} is a ${WEEKDAYS[date.getUTCDay()]}, not a ${WEEKDAYS[weekday]}. Tell them the real weekday and ask which they meant.` };
  return { ok: true, date };
}

const ruleWords = (rule) => (rule.kind === "wednesday" ? `the ${NTH_WORD[rule.nth]} Wednesday` : `on the ${ordinal(rule.day)}`);

// What the bot reads back: the chosen date, how it was chosen, and one later payment date to offer instead.
export function pickDraftDate({ depositDay, requested, factDepositDay, dob, today }) {
  if (requested) {
    const r = resolveRequested(requested, today);
    if (!r.ok) return r;
    return { ok: true, date: r.date, draft_date: mdy(r.date), say: spoken(r.date), basis: "the date you asked for", alternative_say: null };
  }
  const stated = ruleFromText(depositDay ?? factDepositDay);
  const rule = stated ?? ruleFromDob(dob);
  if (!rule) return { ok: false, error: "No date of birth or deposit day to go on. Ask them when their Social Security arrives, then call pick_draft_date again with deposit_day." };
  const [first, second] = nextDraftDates(rule, today);
  const basis = stated
    ? `you said it comes ${ruleWords(rule)}`
    : `born on the ${ordinal(parseDob(dob)[2])}, so Social Security usually comes ${ruleWords(rule)}`;
  const movedEarly = rule.kind === "wednesday" ? first.getUTCDay() !== 3 : first.getUTCDate() !== rule.day;
  const why = movedEarly ? "; that day is a weekend or holiday this time, so it comes the business day before" : "";
  return { ok: true, date: first, draft_date: mdy(first), say: spoken(first), basis: basis + why, alternative_say: second ? spoken(second) : null };
}
