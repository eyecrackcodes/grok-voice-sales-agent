// One Grok Voice realtime session running the sales bot. Transport-agnostic:
// the Twilio bridge feeds it phone audio, the roleplay harness feeds it text.
import WebSocket from "ws";
import { env } from "../scripts/env.mjs";
import { config } from "./config.mjs";
import { dispatch, getState } from "./hub.mjs";
import { STAGES, FACTS, bridgeStage } from "./flow.mjs";
import { instructions } from "./prompt.mjs";
import { quote } from "./quote.mjs";
import { checkSsn, checkRouting, checkAccount, standardizeAddress } from "./verify.mjs";
import { parseDob } from "./dob.mjs";
import { pickDraftDate, todayUtc } from "./draft-date.mjs";
import { vaultPut, vaultGet, vaultMasked } from "./vault.mjs";

const BOT_FACTS = Object.keys(FACTS).filter((k) => !FACTS[k].serverOnly);

// SSN, account and phone numbers never reach the transcript, the map or the logs.
const maskDigits = (t) => String(t).replace(/\d(?:[\s-]?\d){6,}/g, "[#]");

const OBJECTION_KINDS = ["price_too_high", "need_to_think", "talk_to_spouse_or_family", "already_have_coverage",
  "no_bank_info_on_phone", "scam_or_trust", "not_interested", "health_or_qualification_worry",
  "waiting_period_or_graded", "send_info_by_mail", "call_back_later", "payment_timing_or_fixed_income", "other"];

const TOOLS = [
  { type: "function", name: "set_stage", description: "Move the call to a new stage. Call this the moment the conversation enters it.",
    parameters: { type: "object", required: ["stage"], properties: {
      stage: { type: "string", enum: Object.keys(STAGES).filter((s) => s !== "dialing") },
      mood: { type: "string", enum: ["warm", "neutral", "cold"], description: "how receptive the prospect sounds right now" } } } },
  { type: "function", name: "save_facts", description: "Save facts about the prospect as soon as you hear them, in their words.",
    parameters: { type: "object", properties: Object.fromEntries(BOT_FACTS.map((k) => [k, { type: "string" }])) } },
  { type: "function", name: "verify_address", description: "Check a mailing address. Call once with what they said; read the corrected address back; when they confirm it's exactly right, call again with client_confirmed true.",
    parameters: { type: "object", required: ["street", "city", "state", "zip"], properties: {
      street: { type: "string", description: "house number, street, and unit if any" }, city: { type: "string" },
      state: { type: "string" }, zip: { type: "string" },
      client_confirmed: { type: "boolean", description: "true only after they confirmed the read-back" } } } },
  { type: "function", name: "secure_mode", description: "Turn secure mode on right before asking for the SSN or bank details (pauses the recording), and off when done.",
    parameters: { type: "object", required: ["on"], properties: { on: { type: "boolean" } } } },
  { type: "function", name: "save_sensitive", description: "Save SSN or bank details the moment you hear them. Only the server sees the full numbers; read back only what it returns.",
    parameters: { type: "object", properties: {
      ssn: { type: "string" }, routing_number: { type: "string" }, account_number: { type: "string" },
      account_type: { type: "string", enum: ["checking", "savings"] } } } },
  { type: "function", name: "transfer_to_agent", description: "Live-transfer the prospect to the licensed agent. Say you're connecting them, then call this and stop talking.",
    parameters: { type: "object", required: ["reason"], properties: { reason: { type: "string" } } } },
  { type: "function", name: "get_quote", description: "Get three real monthly prices. Call after the health questions.",
    parameters: { type: "object", required: ["gender", "tobacco", "face_amount"], properties: {
      age: { type: "integer", description: "only if no date of birth was saved" }, gender: { type: "string", enum: ["M", "F"] },
      tobacco: { type: "boolean" }, face_amount: { type: "integer", description: "target coverage in dollars" } } } },
  { type: "function", name: "pick_draft_date", description: "Work out the first draft date. The server owns all date math; read back only what it returns. Pass deposit_day only if they told you when their check comes, and requested if they ask for a specific date.",
    parameters: { type: "object", properties: {
      deposit_day: { type: "string", description: "what they said, e.g. \"the 3rd\" or \"second Wednesday\"" },
      requested: { type: "string", description: "a specific date they asked for, in their words, e.g. \"Monday the 2nd\"" } } } },
  { type: "function", name: "log_objection", description: "Record an objection the moment the prospect raises it, before you answer. Log each distinct objection once.",
    parameters: { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: OBJECTION_KINDS } } } },
  { type: "function", name: "end_call", description: "Hang up after your goodbye has been spoken.",
    parameters: { type: "object", required: ["reason"], properties: { reason: { type: "string" } } } },
];

// Carriers price on age last birthday; the model's own arithmetic on a spoken DOB was off by two years in testing.
export function ageFromDob(dob, today = new Date()) {
  const parsed = parseDob(dob);
  if (!parsed) return null;
  const [y, mo, d] = parsed;
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < mo || (today.getMonth() + 1 === mo && today.getDate() < d)) age--;
  return age;
}

// Same address typed two ways (case, spacing, punctuation) is the same address.
export function addressKey({ street, city, state, zip }) {
  return [street, city, state, zip].map((x) => String(x ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ")).join(" ").replace(/\s+/g, " ").trim();
}

export const SAME_ADDRESS_RETRY = {
  ok: false,
  error: "That is the identical address that already failed.",
  next: "Do not resend the same address. Read the house number back to them one digit at a time, confirm it and the ZIP, then call verify_address again with what changed, or with client_confirmed true if they confirm it is right as given.",
};

// hooks: onAudio(base64), onSpeechStarted(), onTurnDone(), onEndRequested(), onSecure(on),
// onStage(stage) after each successful set_stage post, onTransferRequested(), onTransferReady(), onVoiceClosed(), log(...)
// connect(url, options) replaces the realtime WebSocket, so tests can drive the session with no network.
export function startSession({ callId, lead, params, text = false, hooks = {}, connect = (url, options) => new WebSocket(url, options) }) {
  const log = hooks.log ?? ((...a) => console.log(`[${callId}]`, ...a));
  const post = (event) => dispatch({ callId, ...event });
  let ending = false, transferring = false, toolInTurn = false, pending = 0, doneWhilePending = false, secure = false;
  const pendingAddress = { match: null };
  const failedAddresses = new Set();

  if (!getState(callId)) dispatch({ type: "call_started", callId, lead });
  for (const [key, value] of Object.entries({ first_name: params.firstName, last_name: params.lastName, state: params.state })) if (value) post({ type: "fact", key, value });

  function setSecure(on) {
    if (secure === on) return;
    secure = on;
    hooks.onSecure?.(on);
  }

  async function saveSensitive(args) {
    setSecure(true);
    const out = { ok: true }, errors = [];
    if (args.ssn) {
      const c = checkSsn(args.ssn);
      if (!c.ok) errors.push(c.reason);
      else { vaultPut(callId, { ssn: c.ssn }); post({ type: "fact", key: "ssn_on_file", value: vaultMasked(callId).ssn }); out.ssn_read_back = `ending in ${c.ssn.slice(-4)}`; }
    }
    if (args.routing_number) {
      const c = await checkRouting(args.routing_number);
      if (!c.ok) errors.push(c.reason);
      else { vaultPut(callId, { routing: c.routing, bank: c.bank }); out.bank_name_read_back = c.bank ?? "bank name not found; confirm the number digit by digit instead"; }
    }
    if (args.account_number) {
      const c = checkAccount(args.account_number);
      if (!c.ok) errors.push(c.reason);
      else { vaultPut(callId, { account: c.account }); out.account_read_back = `ending in ${c.account.slice(-4)}`; }
    }
    if (args.account_type) vaultPut(callId, { accountType: args.account_type });
    const v = vaultGet(callId);
    if (v.routing && v.account && v.accountType) post({ type: "fact", key: "bank_on_file", value: vaultMasked(callId).bank });
    else out.still_need = ["routing_number", "account_number", "account_type"].filter((k) => !v[{ routing_number: "routing", account_number: "account", account_type: "accountType" }[k]]);
    return errors.length ? { ok: false, errors, ...out } : out;
  }

  async function verifyAddress(args) {
    if (args.client_confirmed && pendingAddress.match) {
      const m = pendingAddress.match;
      for (const [key, value] of Object.entries({ address: m.street, city: m.city, zip: m.zip, county: m.county })) if (value) post({ type: "fact", key, value });
      post({ type: "fact", key: "address_verified", value: m.unmatched ? "client-confirmed read-back (no Census match)" : "Census-matched, client confirmed" });
      return { ok: true, saved: true };
    }
    const key = addressKey(args);
    if (failedAddresses.has(key)) return SAME_ADDRESS_RETRY;
    const r = await standardizeAddress(args);
    if (!r.ok) failedAddresses.add(key);
    if (r.ok) {
      pendingAddress.match = r;
      return { ok: true, read_back: `${r.street}, ${r.city}, ${r.state} ${r.zip}${r.county ? ` (${r.county})` : ""}`,
        next: "Read this back slowly. If they confirm it's exactly right, call verify_address again with client_confirmed true." };
    }
    // After a careful read-back the client's own confirmation is the fallback when no match exists.
    pendingAddress.match = { street: args.street, city: args.city, zip: args.zip, county: null, unmatched: true };
    return { ok: false, error: r.reason, next: "If after a careful read-back they confirm it is right, call verify_address again with client_confirmed true." };
  }

  async function runTool(name, args) {
    if (name === "set_stage") {
      if (getState(callId)?.stage === args.stage) return { ok: true, stage: args.stage, next: STAGES[args.stage].next ?? [] };
      const r = post({ type: "stage", to: args.stage, mood: args.mood });
      if (r.ok) { hooks.onStage?.(args.stage); return { ok: true, stage: args.stage, next: STAGES[args.stage].next ?? [] }; }
      // The bot often skips one step; walk through it if its own gate allows.
      const via = bridgeStage(getState(callId)?.stage, args.stage);
      if (via && post({ type: "stage", to: via }).ok) {
        hooks.onStage?.(via);
        const r2 = post({ type: "stage", to: args.stage, mood: args.mood });
        if (r2.ok) hooks.onStage?.(args.stage);
        const reached = r2.ok ? args.stage : via;
        return { ok: true, stage: reached, next: STAGES[reached].next ?? [], ...(r2.ok ? {} : { note: `reached ${via}; ${args.stage} not allowed yet: ${r2.error}` }) };
      }
      return { ok: false, error: r.error };
    }
    if (name === "save_facts") {
      const errors = Object.entries(args).filter(([, v]) => v != null && v !== "")
        .map(([key, value]) => (FACTS[key]?.serverOnly ? { ok: false, error: `${key} is set by its own tool, not save_facts` }
          : post({ type: "fact", key, value: maskDigits(value) }))).filter((r) => !r.ok).map((r) => r.error);
      return errors.length ? { ok: false, errors } : { ok: true };
    }
    if (name === "verify_address") return verifyAddress(args);
    if (name === "secure_mode") { setSecure(Boolean(args.on)); return { ok: true, secure }; }
    if (name === "save_sensitive") return saveSensitive(args);
    if (name === "transfer_to_agent") {
      if (getState(callId)?.stage !== "handoff") {
        const r = post({ type: "stage", to: "transferred", note: args.reason });
        if (!r.ok) return { ok: false, error: r.error };
      }
      setSecure(false);
      transferring = true;
      hooks.onTransferRequested?.();
      return { ok: true, say: "You've told them you're connecting them; stop talking now." };
    }
    if (name === "get_quote") {
      const facts = getState(callId)?.facts ?? {};
      if (!facts.case_confirmed)
        return { ok: false, error: "Recap their needs first: play back who they're protecting and why, get their yes, save case_confirmed, then quote." };
      const age = ageFromDob(facts.date_of_birth) ?? args.age;
      if (!age) return { ok: false, error: "Need their date of birth first (save date_of_birth)" };
      const q = quote({ age, gender: args.gender, tobacco: args.tobacco, faceAmount: args.face_amount });
      if (!q.ok) return q;
      post({ type: "fact", key: "age", value: String(age) });
      post({ type: "fact", key: "gender", value: args.gender === "F" ? "Female" : "Male" });
      post({ type: "quote", tier: q.tier, options: q.options });
      return { ...q, age };
    }
    if (name === "pick_draft_date") {
      const facts = getState(callId)?.facts ?? {};
      const r = pickDraftDate({ depositDay: args.deposit_day, requested: args.requested, factDepositDay: facts.ss_deposit_day, dob: facts.date_of_birth, today: todayUtc() });
      if (!r.ok) return r;
      post({ type: "fact", key: "draft_date", value: r.draft_date });
      return { ok: true, draft_date: r.draft_date, say: r.say, basis: r.basis, alternative_say: r.alternative_say };
    }
    if (name === "log_objection") {
      const r = post({ type: "objection", kind: args.kind });
      if (!r.ok) return { ok: false, error: r.error };
      const s = r.state;
      return s.outcome === "lost"
        ? { ok: true, callOver: true, say: "Thank them warmly, then call end_call." }
        : { ok: true, chancesLeft: s.pricePresented ? s.livesLeft : "not counted before price" };
    }
    if (name === "end_call") { ending = true; return { ok: true }; }
    return { ok: false, error: `Unknown tool ${name}` };
  }

  const grok = connect(`wss://api.x.ai/v1/realtime?model=${config.voiceModel}`, { headers: { Authorization: `Bearer ${env("X_API_KEY")}` } });
  const send = (msg) => grok.readyState === WebSocket.OPEN && grok.send(JSON.stringify(msg));

  grok.on("open", () => {
    send({ type: "session.update", session: {
      voice: config.voice,
      instructions: instructions({ firstName: params.firstName, state: params.state, agentName: params.agentName || undefined, source: params.source }),
      turn_detection: text ? null : { type: "server_vad" },
      audio: { input: { format: { type: "audio/pcmu" } }, output: { format: { type: "audio/pcmu" } } },
      tools: TOOLS,
    } });
    post({ type: "stage", to: "intro", mood: "neutral" });
    send({ type: "response.create" });
  });

  // Phone testing: prompting after every tool round left 1 restated line in 32;
  // waiting for the prospect instead made the model resume its cut sentence far more often.
  function afterResponse() {
    const prompt = toolInTurn && !ending && !transferring;
    toolInTurn = false;
    if (prompt) return send({ type: "response.create" });
    if (transferring) return hooks.onTransferReady?.();
    if (ending) return hooks.onEndRequested?.();
    return hooks.onTurnDone?.();
  }

  grok.on("message", (raw, isBinary) => {
    if (isBinary) return hooks.onAudio?.(raw.toString("base64"));
    const ev = JSON.parse(raw);
    switch (ev.type) {
      case "response.output_audio.delta": return hooks.onAudio?.(ev.delta);
      case "input_audio_buffer.speech_started": return hooks.onSpeechStarted?.();
      case "response.output_audio_transcript.done":
        return ev.transcript && post({ type: "transcript", speaker: "bot", text: maskDigits(ev.transcript) });
      case "conversation.item.input_audio_transcription.completed":
        return ev.transcript && post({ type: "transcript", speaker: "prospect", text: secure ? "[secure entry, not shown]" : maskDigits(ev.transcript) });
      case "response.function_call_arguments.done": {
        let args = {};
        try { args = JSON.parse(ev.arguments || "{}"); } catch {}
        toolInTurn = true;
        pending++;
        Promise.resolve(runTool(ev.name, args)).catch((e) => ({ ok: false, error: e.message })).then((result) => {
          const shown = ev.name === "save_sensitive" ? Object.keys(args).join(",") : JSON.stringify(args);
          log("tool", ev.name, shown, "->", JSON.stringify(result).slice(0, 200));
          send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify(result) } });
          if (--pending === 0 && doneWhilePending) { doneWhilePending = false; afterResponse(); }
        });
        return;
      }
      case "response.done":
        if (pending > 0) { doneWhilePending = true; return; }
        return afterResponse();
      case "error":
        return log("grok error", JSON.stringify(ev.error ?? ev));
    }
  });
  // A refused or dropped voice connection must end the call, or it sits at "dialing" forever.
  let opened = false, closed = false;
  grok.on("open", () => { opened = true; });
  grok.on("close", (code) => {
    log("grok closed", code);
    if (!closed && !getState(callId)?.endedAt) post({ type: "call_ended", reason: opened ? `voice connection dropped (${code})` : "voice connection refused" });
    closed = true;
    clearTimeout(cap);
    hooks.onVoiceClosed?.();
  });
  grok.on("error", (e) => log("grok ws error", e.message));
  grok.on("unexpected-response", (_req, res) => {
    log("grok refused", res.statusCode);
    post({ type: "call_ended", reason: `voice connection refused (HTTP ${res.statusCode}${res.statusCode === 403 ? ", check xAI credits" : ""})` });
    closed = true;
    grok.terminate();
  });
  // Hard cap on billed voice minutes per call, whatever else goes wrong.
  const MAX_MINUTES = config.maxCallMinutes ?? 20;
  const cap = setTimeout(() => { log(`hit ${MAX_MINUTES}-minute cap`); hooks.onEndRequested?.(); grok.close(); }, MAX_MINUTES * 60000);
  cap.unref();

  return {
    appendAudio: (payload) => send({ type: "input_audio_buffer.append", audio: payload }),
    sayAsProspect(textLine) {
      post({ type: "transcript", speaker: "prospect", text: textLine });
      send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: textLine }] } });
      send({ type: "response.create" });
    },
    end(reason) {
      post({ type: "call_ended", reason });
      grok.close();
    },
    get ending() { return ending; },
    get transferring() { return transferring; },
  };
}
