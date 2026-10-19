import { test } from "node:test";
import assert from "node:assert/strict";
import { validateUpdate } from "../src/settings-validate.mjs";

const store = { isLocked: () => false };
const check = (values) => validateUpdate({ values }, store);

test("an opener that never says the call is recorded is refused, and one that does is saved", () => {
  for (const key of ["SCRIPT_OPENER_REQUESTED_INFO", "SCRIPT_OPENER_TV_CALLBACK", "SCRIPT_OPENER_INBOUND"]) {
    const bad = check({ [key]: "Hi, this is {bot} from {company}." });
    assert.match(bad.errors[key], /recorded/i, key);
    assert.equal(key in bad.values, false, key);
    const good = check({ [key]: "Hi, this is {bot} from {company}. This call is Recorded." });
    assert.deepEqual(good.errors, {}, key);
    assert.equal(good.values[key], "Hi, this is {bot} from {company}. This call is Recorded.");
  }
});

test("clearing an opener goes back to the default, which already says the call is recorded", async () => {
  const { SETTINGS } = await import("../src/settings-schema.mjs");
  for (const key of ["SCRIPT_OPENER_REQUESTED_INFO", "SCRIPT_OPENER_TV_CALLBACK", "SCRIPT_OPENER_INBOUND"]) {
    assert.match(SETTINGS.find((s) => s.key === key).default, /recorded/i, key);
    assert.deepEqual(check({ [key]: "" }).errors, {});
  }
});

test("the Settings page only accepts a relative .json path inside the project for the rate table", () => {
  for (const bad of ["/etc/passwd", "C:\\rates.json", "\\\\host\\share\\r.json", "../rates.json", "src/../../r.json", "src\\..\\r.json", "src/rates/table.txt", "src/rates"])
    assert.ok(check({ RATE_TABLE: bad }).errors.RATE_TABLE, bad);
  for (const good of ["src/rates/sample-level-plan.json", "data/my-rates.JSON"])
    assert.deepEqual(check({ RATE_TABLE: good }).errors, {}, good);
});
