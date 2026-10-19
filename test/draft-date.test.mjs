import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleFromDob, ruleFromText, paymentDate, nextDraftDates, resolveRequested, spoken, mdy, pickDraftDate } from "../src/draft-date.mjs";

const today = new Date(Date.UTC(2026, 9, 18));
const next = (rule, opts) => nextDraftDates(rule, today, opts).map(mdy);

test("born 1st-10th is paid the second Wednesday, 11th-20th the third, 21st-31st the fourth", () => {
  assert.deepEqual(ruleFromDob("03/04/1950"), { kind: "wednesday", nth: 2 });
  assert.deepEqual(ruleFromDob("1950-03-15"), { kind: "wednesday", nth: 3 });
  assert.deepEqual(ruleFromDob("March 25, 1950"), { kind: "wednesday", nth: 4 });
  assert.equal(ruleFromDob("unknown"), null);
});

test("born on the 4th gets the Veterans Day payment moved to Tuesday, then the second Wednesday of December", () => {
  assert.deepEqual(next(ruleFromDob("03/04/1950")), ["11/10/2026", "12/09/2026"]);
});

test("born the 15th gets a date three days out, then the following month", () => {
  assert.deepEqual(next(ruleFromDob("03/15/1950")), ["10/21/2026", "11/18/2026"]);
});

test("born the 25th gets the fourth Wednesday", () => {
  assert.equal(next(ruleFromDob("03/25/1950"), { count: 1 })[0], "10/28/2026");
});

test("a date inside the lead window is skipped", () => {
  assert.equal(next({ kind: "wednesday", nth: 3 }, { minLeadDays: 4, count: 1 })[0], "11/18/2026");
});

test("the 1st lands on the preceding Friday when it falls on a Sunday", () => {
  assert.equal(next({ kind: "day", day: 1 }, { count: 1 })[0], "10/30/2026");
});

test("the 3rd", () => {
  assert.equal(next({ kind: "day", day: 3 }, { count: 1 })[0], "11/03/2026");
});

test("a fourth Wednesday on Christmas moves to Dec 24", () => {
  assert.equal(new Date(Date.UTC(2030, 11, 25)).getUTCDay(), 3);
  assert.equal(mdy(paymentDate({ kind: "wednesday", nth: 4 }, 2030, 12)), "12/24/2030");
});

test("a payment day on a Saturday New Year steps back across the year to Thursday, since Friday Dec 31 is the observed holiday", () => {
  assert.equal(mdy(paymentDate({ kind: "day", day: 1 }, 2028, 1)), "12/30/2027");
});

test("requested dates resolve to the next future occurrence", () => {
  assert.equal(mdy(resolveRequested("Monday the 2nd", today).date), "11/02/2026");
  assert.equal(mdy(resolveRequested("December 2nd", today).date), "12/02/2026");
  assert.equal(mdy(resolveRequested("the 5th", today).date), "11/05/2026");
  assert.equal(mdy(resolveRequested("11/05", today).date), "11/05/2026");
  assert.equal(mdy(resolveRequested("November 5th", today).date), "11/05/2026");
  assert.equal(mdy(resolveRequested("the 18th", today).date), "11/18/2026");
});

test("a weekday that does not match the date is an error naming the real weekday", () => {
  const r = resolveRequested("Wednesday, November 5th", today);
  assert.equal(r.ok, false);
  assert.match(r.error, /Thursday/);
  assert.equal(resolveRequested("blah", today).ok, false);
});

test("spoken and mdy format a date", () => {
  const d = new Date(Date.UTC(2026, 10, 11));
  assert.equal(spoken(d), "Wednesday, November 11th");
  assert.equal(spoken(new Date(Date.UTC(2026, 11, 2))), "Wednesday, December 2nd");
  assert.equal(mdy(new Date(Date.UTC(2026, 11, 2))), "12/02/2026");
});

test("ruleFromText understands what a caller says", () => {
  const day = (n) => ({ kind: "day", day: n });
  const wed = (n) => ({ kind: "wednesday", nth: n });
  for (const [text, rule] of [["the 1st", day(1)], ["first of the month", day(1)], ["3rd", day(3)], ["third", day(3)],
    ["second Wednesday", wed(2)], ["2nd Wednesday", wed(2)], ["third Wednesday", wed(3)], ["fourth Wednesday", wed(4)]])
    assert.deepEqual(ruleFromText(text), rule, text);
  for (const text of ["whenever", "", undefined, "the 15th", "first Wednesday"]) assert.equal(ruleFromText(text), null, String(text));
});

test("pickDraftDate: a requested date wins, then what they said, then their birthday", () => {
  const dob = "03/04/1950";
  const asked = pickDraftDate({ requested: "Monday the 2nd", depositDay: "the 3rd", dob, today });
  assert.deepEqual([asked.draft_date, asked.basis], ["11/02/2026", "the date you asked for"]);
  const said = pickDraftDate({ depositDay: "the 3rd", dob, today });
  assert.deepEqual([said.draft_date, said.basis], ["11/03/2026", "you said it comes on the 3rd"]);
  const born = pickDraftDate({ dob, today });
  assert.equal(born.say, "Tuesday, November 10th");
  assert.equal(born.alternative_say, "Wednesday, December 9th");
  assert.equal(born.basis, "born on the 4th, so Social Security usually comes the second Wednesday; that day is a weekend or holiday this time, so it comes the business day before");
  assert.equal(pickDraftDate({ factDepositDay: "third Wednesday", today }).draft_date, "10/21/2026");
});

test("pickDraftDate asks when Social Security arrives if nothing is known", () => {
  const r = pickDraftDate({ today });
  assert.equal(r.ok, false);
  assert.match(r.error, /when their Social Security arrives/);
});

test("the basis explains a payment moved early for a weekend or holiday, and stays plain otherwise", () => {
  const today = new Date(Date.UTC(2026, 9, 18));
  assert.match(pickDraftDate({ dob: "08/04/1942", today }).basis, /second Wednesday; that day is a weekend or holiday/);
  assert.match(pickDraftDate({ depositDay: "the 1st", dob: "08/04/1942", today }).basis, /comes on the 1st; that day is a weekend or holiday/);
  assert.doesNotMatch(pickDraftDate({ dob: "08/15/1942", today }).basis, /weekend or holiday/);
});

const pay = (day, y, m) => mdy(paymentDate({ kind: "day", day }, y, m));

test("Labor Day 2026 (Sep 7) moves a payment to the Friday before", () => {
  assert.equal(pay(7, 2026, 9), "09/04/2026");
});

test("July 4 on a Saturday is observed Friday July 3, so a payment on the 3rd moves to Thursday", () => {
  assert.equal(pay(3, 2026, 7), "07/02/2026");
});

test("Thanksgiving, MLK, Presidents, Memorial and Columbus Day are skipped in any year", () => {
  assert.equal(pay(26, 2026, 11), "11/25/2026");
  assert.equal(pay(25, 2027, 11), "11/24/2027");
  assert.equal(pay(19, 2026, 1), "01/16/2026");
  assert.equal(pay(15, 2027, 2), "02/12/2027");
  assert.equal(pay(25, 2030, 5), "05/24/2030");
  assert.equal(pay(12, 2026, 10), "10/09/2026");
});

test("a Sunday holiday is observed Monday: Juneteenth 2022 fell on Sunday, so Monday June 20 is a holiday", () => {
  assert.equal(pay(20, 2022, 6), "06/17/2022");
});

test("a requested Saturday is refused with the nearest business day after it", () => {
  const r = pickDraftDate({ requested: "11/14/2026", dob: "03/04/1950", today });
  assert.equal(r.ok, false);
  assert.match(r.error, /Monday, November 16th/);
  assert.match(r.error, /11\/16\/2026/);
});

test("a requested holiday or a date inside the lead time is refused with the next valid day", () => {
  const holiday = pickDraftDate({ requested: "11/26/2026", today });
  assert.equal(holiday.ok, false);
  assert.match(holiday.error, /Friday, November 27th/);
  const tooSoon = pickDraftDate({ requested: "10/19/2026", today });
  assert.equal(tooSoon.ok, false);
  assert.match(tooSoon.error, /Tuesday, October 20th/);
  assert.equal(pickDraftDate({ requested: "10/20/2026", today }).ok, true);
});
