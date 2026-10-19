// Live transfer to the licensed agent. Replacing the call's TwiML ends the bot's
// media stream and bridges the prospect to the agent; the agent first hears a
// whisper (served through the tunnel) so they pick up already knowing the case.
import { twilio } from "../scripts/twilio.mjs";
import { env } from "../scripts/env.mjs";
import { config } from "./config.mjs";
import { vaultMasked } from "./vault.mjs";

const whispers = new Map();
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function whisperText(state) {
  const f = state.facts;
  const o = (state.quote?.options ?? []).find((x) => String(f.chosen_option ?? "").replace(/,/g, "").includes(String(x.face)));
  const m = vaultMasked(state.callId);
  return [
    `Transfer from ${config.botName}. ${f.first_name ?? "Client"} ${f.last_name ?? ""}, ${f.age ?? ""}, ${f.state ?? ""}.`,
    o ? `${o.carrier}, ${o.face} dollars at ${o.monthly} a month.` : `Plan: ${f.chosen_option ?? "not chosen yet"}.`,
    f.draft_date ? `Draft ${f.draft_date}.` : "",
    `Social ${m.ssn ? "captured" : "not captured"}. Bank ${m.bank ? "captured, routing verified" : "not captured"}.`,
    "Everything is in the CRM. Connecting now.",
  ].filter(Boolean).join(" ");
}

export function whisperTwiml(callId, secret) {
  const w = whispers.get(callId);
  if (!w || w.secret !== secret) return null;
  return `<Response><Say voice="Polly.Matthew-Neural">${esc(w.text)}</Say></Response>`;
}

// A queue answers the dial itself, so there is nobody to whisper to. It gets the caller's own
// number instead, which is how a call queue matches the transfer to the caller's lead.
export function transferTwiml({ agent, callerId, whisperUrl }) {
  const number = whisperUrl ? `<Number url="${esc(whisperUrl)}">${esc(agent)}</Number>` : `<Number>${esc(agent)}</Number>`;
  return `<Response><Dial callerId="${esc(callerId)}" timeout="25" answerOnBridge="true">${number}</Dial>`
    + `<Say voice="Polly.Joanna-Neural">I'm sorry, our licensed agent couldn't pick up this second. We'll call you right back. Thank you so much.</Say></Response>`;
}

// person: whisper a summary to whoever answers and show our number. queue: connect straight
// through showing the caller's own number (ours when we don't know it).
export function buildTransfer({ mode = config.transferMode, agent, ourNumber, callerPhone, whisperUrl }) {
  return mode === "queue"
    ? transferTwiml({ agent, callerId: callerPhone || ourNumber })
    : transferTwiml({ agent, callerId: ourNumber, whisperUrl });
}

export async function transferToAgent({ callSid, callId, publicBase, state, secret, callerPhone, agent = config.agentTransferNumber || env("AGENT_TRANSFER_NUMBER") }) {
  whispers.set(callId, { text: whisperText(state), secret });
  const whisperUrl = `${publicBase}/twiml/whisper?callId=${encodeURIComponent(callId)}&secret=${encodeURIComponent(secret)}`;
  const twiml = buildTransfer({ agent, ourNumber: env("TWILIO_PHONE_NUMBER"), callerPhone, whisperUrl });
  await twilio(`/Calls/${callSid}.json`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Twiml: twiml }),
  });
}

// Pausing during SSN and bank capture keeps those numbers out of the recording entirely.
export async function setRecording(callSid, paused) {
  await twilio(`/Calls/${callSid}/Recordings/Twilio.CURRENT.json`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(paused ? { Status: "paused", PauseBehavior: "skip" } : { Status: "in-progress" }),
  });
}
