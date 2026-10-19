import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsStore, parseDotenv } from "../src/settings.mjs";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "gvsa-settings-")), "settings.json");

test("precedence: startup environment, then settings.json, then .env, then the default", () => {
  const file = tempFile();
  writeFileSync(file, JSON.stringify({ BOT_NAME: "Saved", COMPANY_NAME: "Saved Co", VOICE: "ara" }));
  const env = { BOT_NAME: "FromDocker", EMPTY_IN_ENV: "" };
  const store = createSettingsStore({ file, env, dotenv: { BOT_NAME: "Dot", COMPANY_NAME: "Dot Co", AGENT_NAME: "Dot Agent", EMPTY_IN_ENV: "dot" } });
  assert.equal(env.BOT_NAME, "FromDocker");
  assert.equal(store.sourceOf("BOT_NAME"), "environment");
  assert.equal(store.isLocked("BOT_NAME"), true);
  assert.equal(env.COMPANY_NAME, "Saved Co");
  assert.equal(store.sourceOf("COMPANY_NAME"), "settings");
  assert.equal(env.AGENT_NAME, "Dot Agent");
  assert.equal(store.sourceOf("AGENT_NAME"), ".env");
  assert.equal(env.EMPTY_IN_ENV, "dot", "an empty environment variable does not lock the key");
  assert.equal(store.isLocked("EMPTY_IN_ENV"), false);
  assert.equal(store.sourceOf("CARRIER_NAME"), "default");
  assert.equal(env.CARRIER_NAME, undefined);
});

test("a save persists across a restart, applies to the environment at once, and a cleared key falls back to .env", () => {
  const file = tempFile();
  const env = {};
  const store = createSettingsStore({ file, env, dotenv: { BOT_NAME: "Dot" } });
  store.save({ values: { BOT_NAME: "Maria", COMPANY_NAME: "Acme" } });
  assert.equal(env.BOT_NAME, "Maria");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { BOT_NAME: "Maria", COMPANY_NAME: "Acme" });

  const env2 = {};
  const again = createSettingsStore({ file, env: env2, dotenv: { BOT_NAME: "Dot" } });
  assert.equal(env2.BOT_NAME, "Maria", "settings.json beats .env after a restart");
  again.save({ clear: ["BOT_NAME", "COMPANY_NAME"] });
  assert.equal(env2.BOT_NAME, "Dot");
  assert.equal(again.sourceOf("BOT_NAME"), ".env");
  assert.equal(env2.COMPANY_NAME, undefined);
  assert.equal(again.sourceOf("COMPANY_NAME"), "default");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
});

test("the write replaces the file whole and leaves no temp file behind, owner-only where the OS allows", () => {
  const file = tempFile();
  writeFileSync(file, JSON.stringify({ OLD: "x" }));
  const store = createSettingsStore({ file, env: {} });
  store.save({ values: { BOT_NAME: "Maria" } });
  assert.deepEqual(readdirSync(join(file, "..")), ["settings.json"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { OLD: "x", BOT_NAME: "Maria" });
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a failed write leaves the environment and the saved values unchanged", () => {
  const blocker = join(tempFile(), "..", "not-a-dir");
  writeFileSync(blocker, "");
  const env = {};
  const store = createSettingsStore({ file: join(blocker, "settings.json"), env });
  assert.throws(() => store.save({ values: { BOT_NAME: "Maria" } }));
  assert.equal(env.BOT_NAME, undefined);
  assert.equal(store.sourceOf("BOT_NAME"), "default");
});

test("VAULT_KEY is generated once, 32 random bytes, and saved", () => {
  const file = tempFile();
  const env = {};
  const store = createSettingsStore({ file, env });
  assert.equal(store.ensureVaultKey(), true);
  assert.equal(Buffer.from(env.VAULT_KEY, "base64").length, 32);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).VAULT_KEY, env.VAULT_KEY);
  const first = env.VAULT_KEY;
  assert.equal(store.ensureVaultKey(), false);
  assert.equal(env.VAULT_KEY, first);
  const locked = { VAULT_KEY: "from-docker" };
  assert.equal(createSettingsStore({ file: tempFile(), env: locked }).ensureVaultKey(), false);
  assert.equal(locked.VAULT_KEY, "from-docker");
});

test("a corrupt settings file stops startup with a message naming the file", () => {
  const file = tempFile();
  writeFileSync(file, "{ not json");
  assert.throws(() => createSettingsStore({ file, env: {} }), /settings\.json is not valid JSON/);
});

test(".env parsing keeps the old rules: KEY=value lines, quotes stripped, blanks ignored", () => {
  assert.deepEqual(parseDotenv("# comment\nA=1\nB=\"two\"\nC=\nlower=x\r\nD= spaced \n"), { A: "1", B: "two", D: "spaced" });
});
