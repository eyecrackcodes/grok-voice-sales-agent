import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { quote, annual, monthly } from "../src/quote.mjs";
import { config } from "../src/config.mjs";

const table = JSON.parse(readFileSync(new URL("../src/rates/sample-level-plan.json", import.meta.url), "utf8"));

test("the shipped sample table is labelled as sample data and covers ages 50-85", () => {
  assert.match(table.source, /SAMPLE DATA, NOT REAL RATES/);
  for (let age = 50; age <= 85; age++) for (const g of ["M", "F"]) for (const t of ["N", "T"]) assert.ok(table.rates[age][g][t] > 0, `${age}${g}${t}`);
  assert.equal(table.policyFeeAnnual, 30);
  assert.equal(table.modalMonthly, 0.088);
});

test("premium = (rate x face / 1000 + fee) annually, times the monthly factor, rounded to cents", () => {
  const rate = table.rates[70].F.N;
  const expectedAnnual = Math.round((rate * 10 + 30) * 100) / 100;
  assert.equal(annual(rate, 10000), expectedAnnual);
  assert.equal(monthly(rate, 10000), Math.round(expectedAnnual * 0.088 * 100) / 100);
});

test("quote returns three options around the target using the configured carrier and the table's rates", () => {
  const q = quote({ age: 68, gender: "M", tobacco: true, faceAmount: 10000 });
  assert.equal(q.ok, true);
  assert.deepEqual(q.options.map((o) => o.face), [7500, 10000, 15000]);
  const rate = table.rates[68].M.T;
  for (const o of q.options) {
    assert.equal(o.carrier, config.carrierName);
    assert.equal(o.annual, Math.round((rate * o.face / 1000 + 30) * 100) / 100);
    assert.equal(o.monthly, Math.round(o.annual * 0.088 * 100) / 100);
  }
});

test("tobacco and gender change the rate, and ages outside the table are refused", () => {
  const m = (g, t) => quote({ age: 60, gender: g, tobacco: t, faceAmount: 10000 }).options[1].monthly;
  assert.ok(m("M", true) > m("M", false));
  assert.ok(m("M", false) > m("F", false));
  assert.equal(quote({ age: 49, gender: "M", tobacco: false, faceAmount: 10000 }).ok, false);
});
