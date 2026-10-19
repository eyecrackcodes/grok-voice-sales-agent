// Writes .env.example from the settings table, so the file can never drift from the
// Settings page. Run: npm run env-example
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GROUPS, SETTINGS } from "../src/settings-schema.mjs";

const ENV_ONLY = [
  ["HOST", "Bind address. Anything but loopback requires DASHBOARD_TOKEN.", "127.0.0.1"],
  ["PORT", "Port the server listens on.", "4319"],
  ["BASE_URL", "Base URL the helper scripts use to reach the server (default http://HOST:PORT).", ""],
  ["SETTINGS_FILE", "Where the Settings page saves its values (default data/settings.json).", ""],
  ["CALL_LOG_DIR", "Set to off to stop writing call event logs to data/calls.", ""],
  ["CRM_DATA_DIR", "Where the none CRM keeps leads.csv and outcomes.jsonl (default data/).", ""],
  ["TWILIO_SIGNATURE_CHECK", "Set to off only while troubleshooting: skips the Twilio signature check on inbound webhooks. Never on the Settings page.", "on"],
  ["GRADER_RUBRIC_FILE", "Optional JSON file with extra grader rubric items; see scripts/grade-call.mjs.", ""],
];

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const shownDefault = (s) => (s.type === "secret" || s.type === "textarea" || s.default === undefined || s.default === "" ? "" : String(s.default));

export function renderEnvExample() {
  const out = [
    "# Everything here can be set on the Settings page instead (npm start, then open the URL it prints).",
    "# Values saved on that page win over this file. Never commit .env. Blank values use the default.",
  ];
  for (const g of GROUPS) {
    out.push("", `# ---- ${g.title} ----`);
    for (const s of SETTINGS.filter((r) => r.group === g.id)) {
      out.push(`# ${oneLine(s.label)}${s.help ? `. ${oneLine(s.help)}` : ""}`);
      out.push(`${s.key}=${shownDefault(s)}`);
    }
  }
  out.push("", "# ---- Server only (not on the Settings page) ----");
  for (const [key, help, value] of ENV_ONLY) out.push(`# ${help}`, `${key}=${value}`);
  return `${out.join("\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL("../.env.example", import.meta.url), renderEnvExample());
  console.log("wrote .env.example");
}
