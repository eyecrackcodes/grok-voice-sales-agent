// Twilio Media Stream transport for the sales bot session. Both sides speak
// G.711 mu-law at 8 kHz, so audio passes through untouched.
import WebSocket from "ws";
import { twilio } from "../scripts/twilio.mjs";
import { startSession } from "./session.mjs";
import { getState } from "./hub.mjs";
import { crm } from "./crm/index.mjs";
import { transferToAgent, setRecording } from "./transfer.mjs";

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r({ timedOut: true }), ms))]);

export function handleTwilioStream(twilioWs, streamSecret) {
  let streamSid, callSid, callId, leadUid, publicBase, session, crmWrite = null, transferred = false, synced = false;
  const log = (...a) => console.log(`[${callId ?? "?"}]`, ...a);
  const toTwilio = (msg) => twilioWs.readyState === WebSocket.OPEN && twilioWs.send(JSON.stringify(msg));

  const hangUp = () => twilio(`/Calls/${callSid}.json`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Status: "completed" }),
  }).catch((e) => log("hangup failed", e.message));

  const leadFor = async (id) => (await crm.getLead(id).catch(() => null)) ?? { id };

  // The record must be complete before the agent picks up, so the write starts
  // as soon as the bot asks to transfer, while it is still saying goodbye.
  function startCrmWrite() {
    if (crmWrite || !leadUid) return crmWrite;
    const state = getState(callId);
    crmWrite = leadFor(leadUid)
      .then((lead) => crm.writeHandoff({ lead, state, status: state.outcome === "won" ? "complete" : "transfer" }))
      .then((r) => { synced = true; log("crm handoff written", JSON.stringify(r)); return r; })
      .catch((e) => { log("crm handoff failed", e.message); return { error: e.message }; });
    return crmWrite;
  }

  async function transferNow() {
    if (transferred) return;
    transferred = true;
    await withTimeout(startCrmWrite() ?? Promise.resolve(), 8000);
    try {
      await transferToAgent({ callSid, callId, publicBase, state: getState(callId), secret: streamSecret });
      log("transferred to agent");
    } catch (e) {
      log("transfer failed", e.message);
    }
  }

  async function writeOutcome() {
    if (synced || transferred || !leadUid) return;
    synced = true;
    const state = getState(callId);
    if (!state?.outcome || state.outcome === "won" || state.outcome === "transferred") return;
    try { log("crm outcome written", JSON.stringify(await crm.writeOutcome({ lead: await leadFor(leadUid), state }))); }
    catch (e) { log("crm outcome failed", e.message); }
  }

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.event === "start") {
      const p = msg.start.customParameters ?? {};
      if (p.secret !== streamSecret) return twilioWs.close();
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid;
      callId = p.callId ?? callSid;
      leadUid = p.leadUid || null;
      publicBase = p.publicBase;
      session = startSession({
        callId,
        lead: { uid: leadUid, name: p.firstName, callSid, source: p.source },
        params: p,
        hooks: {
          onAudio: (payload) => toTwilio({ event: "media", streamSid, media: { payload } }),
          onSpeechStarted: () => toTwilio({ event: "clear", streamSid }),
          onSecure: (on) => setRecording(callSid, on).then(() => log(`recording ${on ? "paused" : "resumed"}`))
            .catch((e) => log("recording toggle failed", e.message)),
          onTransferRequested: startCrmWrite,
          // Marks come back once Twilio has played everything queued before them.
          onTransferReady: () => toTwilio({ event: "mark", streamSid, mark: { name: "transfer" } }),
          onEndRequested: () => toTwilio({ event: "mark", streamSid, mark: { name: "goodbye" } }),
        },
      });
    } else if (msg.event === "media") {
      session?.appendAudio(msg.media.payload);
    } else if (msg.event === "mark" && msg.mark?.name === "goodbye") {
      hangUp();
    } else if (msg.event === "mark" && msg.mark?.name === "transfer") {
      transferNow();
    } else if (msg.event === "stop") {
      session?.end(transferred ? "transferred to agent" : session.ending ? "bot ended" : "prospect hung up");
      writeOutcome();
    }
  });
  twilioWs.on("close", () => { session?.end("stream closed"); writeOutcome(); });
}
