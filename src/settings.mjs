// The settings store: what the Settings page saves, layered over .env and the schema defaults.
// Precedence, highest first: a variable already in the process environment at startup
// (docker -e, a shell export) is locked; then data/settings.json; then .env; then the default.
// Saved values are written into the environment, so every process.env reader sees them live.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const DEFAULT_FILE = fileURLToPath(new URL("../data/settings.json", import.meta.url));
const DOTENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

export function parseDotenv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (!/^[A-Z0-9_]+=/.test(line)) continue;
    const i = line.indexOf("=");
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (value) out[line.slice(0, i)] = value;
  }
  return out;
}

function readSaved(file) {
  if (!existsSync(file)) return {};
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}). Fix it or delete it to start over.`);
  }
  return Object.fromEntries(Object.entries(parsed ?? {}).map(([k, v]) => [k, String(v)]));
}

export function createSettingsStore({ file = DEFAULT_FILE, env = process.env, dotenv = {} } = {}) {
  const blank = (k) => env[k] === undefined || env[k] === "";
  const locked = new Set(Object.keys(env).filter((k) => !blank(k)));
  let saved = readSaved(file);
  for (const [k, v] of Object.entries(saved)) if (!locked.has(k)) env[k] = v;
  for (const [k, v] of Object.entries(dotenv)) if (blank(k)) env[k] = v;

  // Temp file then rename, so a crash mid-write never leaves a half-written settings file.
  const write = (next) => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  };

  return {
    file,
    get: (key) => env[key] ?? "",
    isSet: (key) => !blank(key),
    isLocked: (key) => locked.has(key),
    sourceOf(key) {
      if (locked.has(key)) return "environment";
      if (key in saved) return "settings";
      if (key in dotenv) return ".env";
      return "default";
    },
    // Expects validated input: values are strings, and no key is locked.
    save({ values = {}, clear = [] }) {
      const next = { ...saved };
      for (const k of clear) delete next[k];
      Object.assign(next, values);
      write(next);
      saved = next;
      for (const k of clear) { if (k in dotenv) env[k] = dotenv[k]; else delete env[k]; }
      Object.assign(env, values);
    },
    ensureVaultKey() {
      if (!blank("VAULT_KEY")) return false;
      this.save({ values: { VAULT_KEY: randomBytes(32).toString("base64") } });
      return true;
    },
  };
}

export const settings = createSettingsStore({
  file: process.env.SETTINGS_FILE || DEFAULT_FILE,
  dotenv: existsSync(DOTENV_FILE) ? parseDotenv(readFileSync(DOTENV_FILE, "utf8")) : {},
});
