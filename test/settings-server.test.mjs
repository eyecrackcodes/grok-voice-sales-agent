import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test("the real server: /healthz is public and bare, /api/settings needs the token, startup prints the Settings URL", async (t) => {
  const port = await freePort();
  const file = join(mkdtempSync(join(tmpdir(), "gvsa-server-")), "settings.json");
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DASHBOARD_TOKEN: "server-test-token-123", SETTINGS_FILE: file, CRM_PROVIDER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let out = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 15000);
    const onData = (d) => { out += d; if (out.includes("Settings on")) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => { out += d; });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out}`)); });
  });
  child.removeAllListeners("exit");
  assert.match(out, new RegExp(`Settings on http://127\\.0\\.0\\.1:${port}/settings`));
  assert.ok(!out.includes("server-test-token-123"), "the token is not logged");

  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const tunneled = await fetch(`${base}/healthz`, { headers: { "cf-connecting-ip": "203.0.113.9" } });
  assert.equal(tunneled.status, 200, "reachable through the tunnel, which blocks everything else");
  assert.equal((await fetch(`${base}/api/settings`)).status, 401);
  assert.equal((await fetch(`${base}/settings`)).status, 401);
  const authed = await fetch(`${base}/api/settings`, { headers: { authorization: "Bearer server-test-token-123" } });
  assert.equal(authed.status, 200);
  const body = await authed.json();
  assert.equal(body.settings.find((s) => s.key === "DASHBOARD_TOKEN").source, "environment");
  const vault = body.settings.find((s) => s.key === "VAULT_KEY");
  assert.equal(vault.set, true);
  if (vault.source === "settings") assert.equal(Buffer.from(JSON.parse(readFileSync(file, "utf8")).VAULT_KEY, "base64").length, 32, "VAULT_KEY created on first start");
});
