import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "crm-find-"));
process.env.CRM_DATA_DIR = dir;
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
writeFileSync(join(dir, "leads.csv"), [
  "id,first_name,last_name,phone,state,timezone,dnc,created_at",
  `old,Olive,Stone,(555) 555-0111,Ohio,America/Chicago,false,${minutesAgo(600)}`,
  `fresh,Fran,Stone,+15555550111,Ohio,America/Chicago,false,${minutesAgo(5)}`,
  `undated,Una,Stone,5555550122,Ohio,America/Chicago,false,`,
].join("\n"));
const none = await import("../src/crm/none.mjs");
const { newestLeads, findByPhone: dsbFind } = await import("../src/crm/dsb.mjs");

test("none: any match takes the newest lead with that number, whatever its formatting", async () => {
  assert.equal((await none.findByPhone("+15555550111")).id, "fresh");
  assert.equal((await none.findByPhone("5555550122")).id, "undated");
  assert.equal(await none.findByPhone("5555550199"), null);
  assert.equal(await none.findByPhone("anonymous"), null);
});

test("none: recent match skips an old or undated lead", async () => {
  assert.equal((await none.findByPhone("5555550111", { recentMinutes: 30 })).id, "fresh");
  assert.equal(await none.findByPhone("5555550122", { recentMinutes: 30 }), null);
});

test("dsb: newest first, and recent keeps only leads created in the window", () => {
  const now = Date.parse("2026-10-18T19:30:00Z");
  const old = { lead_uid: "march", create_date: "2026-03-25 13:46:53" };
  const fresh = { lead_uid: "now", create_date: "2026-10-18 19:29:10" };
  const earlier = { lead_uid: "earlier", create_date: "2026-10-18 19:05:00" };
  assert.deepEqual(newestLeads([old, earlier, fresh], { now }).map((l) => l.lead_uid), ["now", "earlier", "march"]);
  assert.deepEqual(newestLeads([old, earlier, fresh], { recentMinutes: 30, now }).map((l) => l.lead_uid), ["now", "earlier"]);
  assert.deepEqual(newestLeads([old], { recentMinutes: 30, now }), []);
  assert.deepEqual(newestLeads([{ lead_uid: "x", create_date: "" }], { recentMinutes: 30, now }), []);
});

test("dsb: a number that is not ten digits is not searched", async () => {
  assert.equal(await dsbFind("12345"), null);
});
