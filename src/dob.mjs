const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Returns [year, month, day] from the ways a caller or the CRM writes a date of birth, or null.
export function parseDob(dob) {
  const s = String(dob ?? "").toLowerCase();
  let m = s.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return [+m[3], +m[1], +m[2]];
  if ((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) return [+m[1], +m[2], +m[3]];
  if ((m = s.match(/([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/)) && MONTHS.includes(m[1]))
    return [+m[3], MONTHS.indexOf(m[1]) + 1, +m[2]];
  return null;
}
