// Runs the real bot session against a Grok-played prospect, entirely in text,
// so script changes can be tested in minutes without a phone call. It runs in
// the server process, so the live map shows it like any other call.
import { readFileSync } from "node:fs";
import { env } from "../scripts/env.mjs";
import { config } from "./config.mjs";
import { startSession } from "./session.mjs";
import { subscribe } from "./hub.mjs";

const PERSONAS = JSON.parse(readFileSync(new URL("../sim/personas.json", import.meta.url), "utf8"));
const MAX_TURNS = 70;

async function prospectReply(card, history) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prospectReplyOnce(card, history);
    } catch (e) {
      if (attempt >= 6 || !/ (429|5\d\d)$/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

async function prospectReplyOnce(card, history) {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("X_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "grok-4.3",
      temperature: 0.7,
      messages: [
        { role: "system", content: `${card}\n\nA couple of weeks ago you filled out a form about final expense insurance, though you may not remember the details. You just answered your phone. Reply as yourself, out loud, in one or two short natural sentences. Answer only what was asked; don't volunteer extra detail. If you would hang up, reply with exactly [HANGUP].` },
        ...history,
      ],
    }),
  });
  if (!res.ok) throw new Error(`prospect model ${res.status}`);
  return (await res.json()).choices[0].message.content.trim();
}

// Practice calls spend real xAI credit, so only a couple may run at once.
const MAX_ACTIVE = Number(process.env.PRACTICE_MAX_ACTIVE ?? 2);
let active = 0;

export function runRoleplay(personaKey) {
  if (active >= MAX_ACTIVE) throw new Error(`${active} practice calls already running (limit ${MAX_ACTIVE}); try again when one finishes`);
  const persona = PERSONAS[personaKey];
  if (!persona) throw new Error(`Unknown persona ${personaKey}; have ${Object.keys(PERSONAS).join(", ")}`);
  const callId = `rp-${personaKey}-${Date.now().toString(36)}`;
  const history = [];
  let botSaid = [], turns = 0, done = false;

  const unsubscribe = subscribe(({ callId: id, event }) => {
    if (id === callId && event.type === "transcript" && event.speaker === "bot") botSaid.push(event.text);
  });
  active++;
  const finish = (reason) => {
    if (done) return;
    done = true;
    active--;
    unsubscribe();
    session.end(reason);
  };

  const session = startSession({
    callId, text: true,
    lead: { name: persona.firstName, roleplay: personaKey },
    params: { firstName: persona.firstName, state: persona.state, agentName: config.agentName },
    hooks: {
      onEndRequested: () => finish("bot ended"),
      onVoiceClosed: () => finish("voice connection closed"),
      async onTurnDone() {
        if (done || !botSaid.length) return;
        history.push({ role: "user", content: botSaid.join(" ") });
        botSaid = [];
        if (++turns > MAX_TURNS) return finish("turn limit");
        try {
          const reply = await prospectReply(persona.card, history);
          if (reply.includes("[HANGUP]")) return finish("prospect hung up");
          history.push({ role: "assistant", content: reply });
          session.sayAsProspect(reply);
        } catch (e) {
          finish(`roleplay error: ${e.message}`);
        }
      },
    },
  });
  return callId;
}
