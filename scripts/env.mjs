// Loads .env into process.env (existing variables win) and exposes env(name)
// for values a feature cannot run without. A missing .env file is fine.
import { readFileSync, existsSync } from "node:fs";

const file = new URL("../.env", import.meta.url);
if (existsSync(file)) {
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!/^[A-Z0-9_]+=/.test(line)) continue;
    const i = line.indexOf("=");
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (value && process.env[line.slice(0, i)] === undefined) process.env[line.slice(0, i)] = value;
  }
}

export function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return v;
}
