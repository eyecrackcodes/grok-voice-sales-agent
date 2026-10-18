// SSN and bank details live only here: AES-256-GCM at rest, never in call
// state, the event log, the transcript, or the map. Records self-delete after
// RETENTION_MS so a finished application doesn't leave secrets lying around.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { env } from "../scripts/env.mjs";

const DIR = new URL("../data/vault/", import.meta.url);
const RETENTION_MS = 72 * 3600 * 1000;
mkdirSync(DIR, { recursive: true });

const key = () => {
  const k = Buffer.from(env("VAULT_KEY"), "base64");
  if (k.length !== 32) throw new Error("VAULT_KEY must be 32 bytes, base64");
  return k;
};
const fileFor = (callId) => new URL(`${callId.replace(/[^\w-]/g, "_")}.enc`, DIR);

function encrypt(obj) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

function decrypt(b64) {
  const raw = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
}

export function vaultGet(callId) {
  const f = fileFor(callId);
  return existsSync(f) ? decrypt(readFileSync(f, "utf8")) : {};
}

export function vaultPut(callId, fields) {
  const next = { ...vaultGet(callId), ...fields, updatedAt: Date.now() };
  writeFileSync(fileFor(callId), encrypt(next));
  return next;
}

const last4 = (s) => String(s ?? "").slice(-4);

export function vaultMasked(callId) {
  const v = vaultGet(callId);
  return {
    ssn: v.ssn ? `•••-••-${last4(v.ssn)}` : null,
    bank: v.account ? `${v.bank ?? "Bank"} ••••${last4(v.account)}${v.accountType ? ` (${v.accountType})` : ""}` : null,
    routingVerified: Boolean(v.routing),
  };
}

export function vaultPurgeExpired(now = Date.now()) {
  for (const f of readdirSync(DIR).filter((f) => f.endsWith(".enc"))) {
    const p = new URL(f, DIR);
    if (now - statSync(p).mtimeMs > RETENTION_MS) unlinkSync(p);
  }
}
vaultPurgeExpired();
setInterval(vaultPurgeExpired, 3600 * 1000).unref();
