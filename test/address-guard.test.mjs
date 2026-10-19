import { test } from "node:test";
import assert from "node:assert/strict";
import { addressKey, SAME_ADDRESS_RETRY } from "../src/session.mjs";

test("the same address typed with different case, spacing and punctuation has one key", () => {
  const a = addressKey({ street: "1234 Oak St.", city: "Tulsa", state: "OK", zip: "74104" });
  const b = addressKey({ street: "1234  oak st", city: "tulsa,", state: "ok", zip: "74104" });
  assert.equal(a, b);
});

test("a changed house number, city, state or ZIP is a different address", () => {
  const base = { street: "1234 Oak St", city: "Tulsa", state: "OK", zip: "74104" };
  for (const change of [{ street: "1243 Oak St" }, { city: "Tulsa East" }, { state: "TX" }, { zip: "74105" }])
    assert.notEqual(addressKey({ ...base, ...change }), addressKey(base), JSON.stringify(change));
});

test("the retry refusal tells the bot to read digits back and not to resend", () => {
  assert.equal(SAME_ADDRESS_RETRY.ok, false);
  assert.match(SAME_ADDRESS_RETRY.next, /one digit at a time/);
  assert.match(SAME_ADDRESS_RETRY.next, /client_confirmed/);
});
