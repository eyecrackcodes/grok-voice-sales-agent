// Every setting a user can change, in one table. The Settings page is drawn from it,
// the settings API validates against it, and config.mjs takes its defaults from it,
// so adding a setting is one row here.
//
// Row: { key, group, label, type, default?, help?, required?, options?, min?, max?, when?, danger?, uiReadOnly? }
//   key       the environment variable name (a .env file can still set any of these)
//   type      secret | text | textarea | number | bool | select | phone | phones | url
//   required  needed before the bot can take or place a call (drives the setup checklist)
//   when      { KEY: value } shows the row only when another setting has that value
//   uiReadOnly  shown as set/unset but never edited from the page

export const GROUPS = [
  { id: "connect", title: "Connect your accounts" },
  { id: "business", title: "Your business" },
  { id: "calls", title: "Calls and transfers" },
  { id: "outbound", title: "Outbound calling" },
  { id: "inbound", title: "Inbound calls" },
  { id: "crm", title: "CRM" },
  { id: "script", title: "Script" },
  { id: "advanced", title: "Advanced" },
];

const VOICES = ["eve", "ara", "leo", "rex", "sal"].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));
const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"]
  .map((z) => ({ value: z, label: z.split("/")[1].replace("_", " ") }));

// Spoken openers. Placeholders: {first} {bot} {company} {bot_intro}. {bot_intro} reads
// "Sarah, a virtual assistant with Acme" when AI disclosure is on and "Sarah with Acme" when off.
const OPENER_REQUESTED_INFO = "Hi, is this {first}? This is {bot_intro} on a recorded line, getting back to you on the final expense information you requested.";
const OPENER_TV_CALLBACK = "Hi, is this {first}? This is {bot_intro} on a recorded line. I'm returning your call; it looks like you called us about the final expense coverage you saw on TV, and we missed you. Sorry about that! Do you have a few minutes now?";
const OPENER_INBOUND = "Thank you for calling {company}! This is {bot_intro} on a recorded line. Who do I have the pleasure of speaking with today?";

export const SETTINGS = [
  { key: "X_API_KEY", group: "connect", label: "xAI API key", type: "secret", required: true, help: "From console.x.ai. Powers the Grok Voice calls." },
  { key: "TWILIO_ACCOUNT_SID", group: "connect", label: "Twilio Account SID", type: "secret", required: true, help: "On your Twilio console home page. Starts with AC." },
  { key: "TWILIO_AUTH_TOKEN", group: "connect", label: "Twilio Auth Token", type: "secret", required: true, help: "Next to the Account SID in the Twilio console." },
  { key: "TWILIO_PHONE_NUMBER", group: "connect", label: "Your Twilio phone number", type: "phone", required: true, help: "Outbound calls come from this number, and inbound calls ring it." },
  { key: "PUBLIC_BASE", group: "connect", label: "Public address of this server", type: "url", required: true, help: "The https address Twilio uses to reach this server, for example https://bot.example.com. See the README for running it on a server or through a tunnel." },

  { key: "COMPANY_NAME", group: "business", label: "Company name", type: "text", default: "Acme Final Expense" },
  { key: "BOT_NAME", group: "business", label: "Bot's name", type: "text", default: "Sarah" },
  { key: "AGENT_NAME", group: "business", label: "Licensed agent's name", type: "text", default: "", help: "Spoken on the call. Leave blank to say \"your licensed agent\", which fits a team or a call queue." },
  { key: "VOICE", group: "business", label: "Voice", type: "select", default: "eve", options: VOICES },
  { key: "CARRIER_NAME", group: "business", label: "Carrier name", type: "text", default: "Sample Carrier", help: "Said when the price is presented: \"<carrier> came back with the best option for you.\"" },
  { key: "CARRIER_BLURB", group: "business", label: "One line about the carrier", type: "text", default: "a sample carrier used for this demo", help: "Finishes \"They're ...\", for example \"rated A by AM Best and have paid claims since 1910\"." },

  { key: "AI_DISCLOSURE", group: "calls", label: "Say it's a virtual assistant when the call starts", type: "bool", default: true, help: "Recommended. Several states require telling people up front when they're talking to AI. If someone asks, the bot always answers honestly either way." },
  { key: "AGENT_TRANSFER_NUMBER", group: "calls", label: "Transfer finished calls to", type: "phone", help: "The phone or call queue the bot hands callers to once the application is ready." },
  { key: "TRANSFER_MODE", group: "calls", label: "That number is", type: "select", default: "person", options: [
    { value: "person", label: "A person (they hear a short summary before the caller joins)" },
    { value: "queue", label: "A call queue (connects straight through and shows the caller's number)" },
  ] },
  { key: "MAX_CALL_MINUTES", group: "calls", label: "Longest call, in minutes", type: "number", default: 20, min: 5, max: 60, help: "A hard cap on billed voice minutes for any one call." },

  { key: "DIAL_ALLOWLIST", group: "outbound", label: "Numbers the bot may call while testing", type: "phones", help: "Demo mode only dials these. Put your own cell here." },
  { key: "CONSENT_CONFIRMED", group: "outbound", label: "I hold written consent for every number I call", type: "bool", default: false, danger: true, help: "Turns demo mode off so the bot can dial your leads. You are responsible for TCPA consent, Do Not Call scrubbing and calling hours. See COMPLIANCE.md." },
  { key: "DIALER_SOURCE", group: "outbound", label: "Your leads are people who", type: "select", default: "tv_callback", options: [
    { value: "requested_info", label: "Requested information" },
    { value: "tv_callback", label: "Called you and were missed" },
  ] },
  { key: "DIALER_LINES", group: "outbound", label: "Calls at once", type: "number", default: 1, min: 1, max: 10 },
  { key: "DIALER_MAX_ATTEMPTS", group: "outbound", label: "Tries per lead", type: "number", default: 3, min: 1, max: 10 },
  { key: "DIALER_GAP_MINUTES", group: "outbound", label: "Minutes between tries", type: "number", default: 120, min: 10, max: 1440 },
  { key: "DIALER_MAX_CALLS_PER_DAY", group: "outbound", label: "Most calls per day", type: "number", default: 25, min: 1, max: 1000 },
  { key: "DIALER_WINDOW_START", group: "outbound", label: "Earliest hour to call (the lead's local time)", type: "number", default: 9, min: 0, max: 23 },
  { key: "DIALER_WINDOW_END", group: "outbound", label: "Stop calling at (the lead's local time)", type: "number", default: 20, min: 1, max: 24 },

  { key: "INBOUND_ENABLED", group: "inbound", label: "Let the bot answer calls to your Twilio number", type: "bool", default: false },
  { key: "INBOUND_FALLBACK_NUMBER", group: "inbound", label: "When the bot can't take a call, send it to", type: "phone", help: "Used when the bot is busy, outside its hours, at its daily limit, or the server is down. Leave blank and callers hear a short \"please call back\" message." },
  { key: "INBOUND_HOUR_START", group: "inbound", label: "Bot answers from (hour, 0-23)", type: "number", default: 9, min: 0, max: 23 },
  { key: "INBOUND_HOUR_END", group: "inbound", label: "Bot answers until (hour, 1-24)", type: "number", default: 19, min: 1, max: 24 },
  { key: "INBOUND_TZ", group: "inbound", label: "Time zone for those hours", type: "select", default: "America/Chicago", options: ZONES },
  { key: "INBOUND_MAX_PER_DAY", group: "inbound", label: "Most calls the bot answers per day", type: "number", default: 10, min: 1, max: 1000 },
  { key: "INBOUND_MAX_ACTIVE", group: "inbound", label: "Calls the bot answers at once", type: "number", default: 1, min: 1, max: 10 },
  { key: "INBOUND_MATCH", group: "inbound", label: "Look up callers in the CRM", type: "select", default: "any", options: [
    { value: "any", label: "Match any lead with the caller's number" },
    { value: "recent", label: "Only leads created in the last 30 minutes (call platforms that post a lead per call)" },
    { value: "off", label: "Don't look callers up" },
  ], help: "Either way the bot asks the caller's name and never greets them by a name it looked up." },
  { key: "INBOUND_ACCEPT_DIGITS", group: "inbound", label: "Keys to press when answering", type: "text", default: "", help: "Only if a call platform asks the receiver to \"press 1 to accept\". Example: w1 (wait half a second, press 1)." },

  { key: "CRM_PROVIDER", group: "crm", label: "CRM", type: "select", default: "none", options: [
    { value: "none", label: "No CRM (leads from data/leads.csv, results to data/outcomes.jsonl)" },
    { value: "dsb", label: "Digital Senior Benefits" },
  ], help: "Changing this takes effect after a restart." },
  { key: "DSB_BASE", group: "crm", label: "CRM API address", type: "url", when: { CRM_PROVIDER: "dsb" } },
  { key: "DSB_CRM_MCP", group: "crm", label: "CRM API token", type: "secret", when: { CRM_PROVIDER: "dsb" }, help: "Use a least-privilege token." },
  { key: "DSB_QUEUE_STATUS", group: "crm", label: "Status of the leads to call", type: "text", default: "55", when: { CRM_PROVIDER: "dsb" } },
  { key: "CRM_CARRIER_ID", group: "crm", label: "Carrier id written on the lead", type: "number", when: { CRM_PROVIDER: "dsb" } },
  { key: "CRM_PRODUCT_ID", group: "crm", label: "Product id written on the lead", type: "number", when: { CRM_PROVIDER: "dsb" } },
  { key: "CRM_BANK_IN_NOTE", group: "crm", label: "Put full bank details in the handoff note", type: "bool", default: false, danger: true, help: "Plain text: anyone who can open the lead can read it. Off writes only the bank name and the last 4 digits." },

  { key: "SCRIPT_OPENER_REQUESTED_INFO", group: "script", label: "Opener: they requested information", type: "textarea", default: OPENER_REQUESTED_INFO, help: "Placeholders: {first} {bot} {company} {bot_intro}." },
  { key: "SCRIPT_OPENER_TV_CALLBACK", group: "script", label: "Opener: returning a missed call", type: "textarea", default: OPENER_TV_CALLBACK, help: "Placeholders: {first} {bot} {company} {bot_intro}." },
  { key: "SCRIPT_OPENER_INBOUND", group: "script", label: "Opener: someone calls in", type: "textarea", default: OPENER_INBOUND, help: "Placeholders: {bot} {company} {bot_intro}. Never greet an inbound caller by a name you looked up." },
  { key: "SCRIPT_EXTRA", group: "script", label: "Extra instructions for the bot", type: "textarea", default: "", help: "House rules, products, phrases to avoid. Added to the end of the bot's instructions." },

  { key: "DASHBOARD_TOKEN", group: "advanced", label: "Dashboard password", type: "secret", help: "Required when this server is reachable from the internet. You'll sign in again after changing it." },
  { key: "VOICE_MODEL", group: "advanced", label: "Voice model", type: "text", default: "grok-voice-3.0" },
  { key: "PRACTICE_MAX_ACTIVE", group: "advanced", label: "Practice calls at once", type: "number", default: 2, min: 1, max: 5, help: "Each practice call spends real xAI credit." },
  { key: "RATE_TABLE", group: "advanced", label: "Rate table file", type: "text", default: "src/rates/sample-level-plan.json", help: "The shipped table is SAMPLE DATA, not real rates. Schema in the README." },
  { key: "TWILIO_SIGNATURE_CHECK", group: "advanced", label: "Check Twilio signatures", type: "select", default: "on", options: [{ value: "on", label: "On" }, { value: "off", label: "Off (troubleshooting only)" }] },
  { key: "TWILIO_STREAM_SIGNATURE", group: "advanced", label: "Media stream signature", type: "select", default: "warn", options: [{ value: "warn", label: "Warn" }, { value: "enforce", label: "Enforce" }] },
  { key: "VAULT_KEY", group: "advanced", label: "Encryption key for SSN and bank details", type: "secret", uiReadOnly: true, help: "Created automatically on first start. Losing it makes saved details unreadable." },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
export const settingFor = (key) => BY_KEY.get(key);
export const defaultOf = (key) => BY_KEY.get(key)?.default;
