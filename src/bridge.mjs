// Twilio Media Stream transport for the sales bot session. Both sides speak
// G.711 mu-law at 8 kHz, so audio passes through untouched.
import WebSocket from "ws";
import { twilio } from "../scripts/twilio.mjs";
import { startSession } from "./session.mjs";
import { getState } from "./hub.mjs";
import { crm } from "./crm/index.mjs";
import { transferToAgent, setRecording } from "./transfer.mjs";
import { config } from "./config.mjs";
import { progressTracker, serialQueue } from "./progress.mjs";
import { release as releaseInbound, lookupCaller } from "./inbound.mjs";

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r({ timedOut: true }), ms))]);

export function handleTwilioStream(twilioWs, streamSecret) {
  let streamSid, callSid, callId, leadUid, publicBase, session, crmWrite = null, transferred = false, synced = false, callerPhone = "";
  let stopped = false, endRequested = false;
  const progress = progressTracker();
  // Every CRM write for the call runs on this queue, so the handoff always lands after an in-flight progress write.
  const crmQueue = serialQueue();

  function writeProgress(stage) {
    if (!stage) return;
    crmQueue(async () => {
      if (crmWrite) return;
      try { log("crm progress written", JSON.stringify(await crm.writeProgress({ lead: await leadFor(leadUid), state: getState(callId), stage }))); }
      catch (e) { log("crm progress failed", e.message); }
    });
  }

  const log = (...a) => console.log(`[${callId ?? "?"}]`, ...a);
  const toTwilio = (msg) => twilioWs.readyState === WebSocket.OPEN && twilioWs.send(JSON.stringify(msg));

  const hangUp = () => twilio(`/Calls/${callSid}.json`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Status: "completed" }),
  }).catch((e) => log("hangup failed", e.message));

  // The lead may be posted to the CRM a little after the call starts, so a caller who wasn't
  // found at pickup is looked up again while the call goes on.
  async function lookUpLate() {
    for (const wait of [20000, 40000, 60000]) {
      await new Promise((r) => setTimeout(r, wait).unref());
      if (leadUid || stopped) return;
      const lead = await lookupCaller(callerPhone);
      if (lead) { leadUid = lead.id; log("crm lead found mid-call"); return writeProgress(progress.leadFound()); }
    }
    log("no crm lead found for this caller");
  }

  const leadFor = async (id) => (await crm.getLead(id).catch(() => null)) ?? { id };

  // The record must be complete before the agent picks up, so the write starts
  // as soon as the bot asks to transfer, while it is still saying goodbye.
  function startCrmWrite() {
    if (crmWrite || !leadUid) return crmWrite;
    const state = getState(callId);
    crmWrite = crmQueue(async () => crm.writeHandoff({ lead: await leadFor(leadUid), state, status: state.outcome === "won" ? "complete" : "transfer" }))
      .then((r) => { synced = true; log("crm handoff written", JSON.stringify(r)); return r; })
      .catch((e) => { log("crm handoff failed", e.message); return { error: e.message }; });
    return crmWrite;
  }

  async function transferNow({ agent } = {}) {
    if (transferred) return;
    transferred = true;
    await withTimeout(startCrmWrite() ?? Promise.resolve(), 8000);
    try {
      await transferToAgent({ callSid, callId, publicBase, state: getState(callId), secret: streamSecret, callerPhone, agent });
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
    await crmQueue(async () => {
      try { log("crm outcome written", JSON.stringify(await crm.writeOutcome({ lead: await leadFor(leadUid), state }))); }
      catch (e) { log("crm outcome failed", e.message); }
    });
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
      callerPhone = p.callerPhone ?? "";
      const inboundCall = p.source === "inbound";
      session = startSession({
        callId,
        lead: { uid: leadUid, name: p.firstName, callSid, source: p.source },
        params: p,
        hooks: {
          onAudio: (payload) => toTwilio({ event: "media", streamSid, media: { payload } }),
          onSpeechStarted: () => toTwilio({ event: "clear", streamSid }),
          onSecure: (on) => setRecording(callSid, on).then(() => log(`recording ${on ? "paused" : "resumed"}`))
            .catch((e) => log("recording toggle failed", e.message)),
          onStage: (stage) => writeProgress(progress.enter(stage, Boolean(leadUid))),
          onTransferRequested: startCrmWrite,
          // Marks come back once Twilio has played everything queued before them.
          onTransferReady: () => toTwilio({ event: "mark", streamSid, mark: { name: "transfer" } }),
          onEndRequested: () => { endRequested = true; toTwilio({ event: "mark", streamSid, mark: { name: "goodbye" } }); },
          // An inbound caller is never left in silence: if the bot's voice fails, hand them to a person, when one is configured.
          onVoiceClosed: () => {
            const rescue = config.agentTransferNumber || config.inbound.fallbackNumber;
            if (inboundCall && rescue && !stopped && !endRequested && !transferred) { log("voice lost, transferring the caller"); transferNow({ agent: rescue }); }
          },
        },
      });
      if (inboundCall && !leadUid && callerPhone && config.inbound.match === "recent") lookUpLate();
      // Outbound calls are recorded from the Calls API; an inbound call has to start its recording here.
      if (inboundCall)
        twilio(`/Calls/${callSid}/Recordings.json`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ RecordingChannels: "dual" }) }).then(() => log("recording started")).catch((e) => log("recording start failed", e.message));
    } else if (msg.event === "media") {
      session?.appendAudio(msg.media.payload);
    } else if (msg.event === "mark" && msg.mark?.name === "goodbye") {
      hangUp();
    } else if (msg.event === "mark" && msg.mark?.name === "transfer") {
      transferNow();
    } else if (msg.event === "stop") {
      stopped = true;
      session?.end(transferred ? "transferred to agent" : session.ending ? "bot ended" : "prospect hung up");
      writeOutcome();
      releaseInbound(callId);
    }
  });
  twilioWs.on("close", () => { stopped = true; session?.end("stream closed"); writeOutcome(); releaseInbound(callId); });
}
