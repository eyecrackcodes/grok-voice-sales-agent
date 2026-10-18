import { test } from "node:test";
import assert from "node:assert/strict";
import { abaChecksumOk, checkSsn, checkAccount } from "../src/verify.mjs";

test("routing check digit accepts published routing numbers and catches a single-digit slip", () => {
  for (const rn of ["021000021", "011000015", "122105155", "111000025"]) assert.equal(abaChecksumOk(rn), true, rn);
  assert.equal(abaChecksumOk("021000022"), false);
  assert.equal(abaChecksumOk("12345678"), false);
});

test("SSN check rejects never-issued areas and all-zero groups, accepts well-formed numbers", () => {
  assert.equal(checkSsn("123-45-6789").ok, true);
  for (const bad of ["000-12-3456", "666-12-3456", "912-34-5678", "123-00-4567", "123-45-0000", "12345678"])
    assert.equal(checkSsn(bad).ok, false, bad);
});

test("account number must be 4 to 17 digits", () => {
  assert.equal(checkAccount("123").ok, false);
  assert.equal(checkAccount("000123456789").ok, true);
  assert.equal(checkAccount("1".repeat(18)).ok, false);
});
