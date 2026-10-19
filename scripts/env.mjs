// Loads saved settings and .env into process.env (see src/settings.mjs for the precedence)
// and exposes env(name) for values a feature cannot run without. A missing .env file is fine.
import "../src/settings.mjs";

export function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Add it on the Settings page, or in .env.`);
  return v;
}
