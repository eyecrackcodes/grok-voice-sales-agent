// Places one bot call through the same path the dialer uses.
//   node scripts/call-lead.mjs <lead id> [--source tv_callback|requested_info]
//   node scripts/call-lead.mjs --phone +1XXXXXXXXXX --name First [--source ...]
// The server must be running and the tunnel up (data/tunnel.log or PUBLIC_BASE).
// Demo mode only dials numbers listed in DIAL_ALLOWLIST. A call costs about
// $0.08 per minute for Grok Voice plus Twilio per-minute pricing.
import "./env.mjs";
import { crm } from "../src/crm/index.mjs";
import { placeCall } from "../src/dialer.mjs";

const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const flagValues = new Set(["--source", "--phone", "--name"].map(opt).filter(Boolean));
const id = argv.find((a) => !a.startsWith("--") && !flagValues.has(a));
const source = opt("--source") ?? "tv_callback";
const phone = opt("--phone");

if (!id && !phone) {
  console.error("usage: node scripts/call-lead.mjs <lead id> [--source tv_callback|requested_info]\n       node scripts/call-lead.mjs --phone +1XXXXXXXXXX --name First");
  process.exit(1);
}

const lead = phone
  ? { id: `adhoc-${Date.now().toString(36)}`, first_name: opt("--name") ?? "", last_name: "", phone, state: opt("--state") ?? "", timezone: "" }
  : await crm.getLead(id);
if (!lead) {
  console.error(`No lead with id ${id}`);
  process.exit(1);
}

try {
  const { callSid, callId, last4 } = await placeCall(lead, { source });
  console.log(`dialing ${lead.first_name} (***-***-${last4}), twilio ${callSid}, map call ${callId}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
