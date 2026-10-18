import WebSocket from "ws";
import { env } from "./env.mjs";

const model = process.argv[2] ?? "grok-voice-3.0";
const ws = new WebSocket(`wss://api.x.ai/v1/realtime?model=${model}`, {
  headers: { Authorization: `Bearer ${env("X_API_KEY")}` },
});

const t0 = Date.now();
let asked, firstAudio, audioBytes = 0, transcript = "";
const types = new Set();
const done = (msg) => {
  console.log(JSON.stringify({ model, msg, connectMs: asked - t0, firstAudioMs: firstAudio && firstAudio - asked, audioBytes, transcript, events: [...types] }, null, 2));
  ws.close();
  process.exit(0);
};
setTimeout(() => done("timeout"), 20000);

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      voice: "eve",
      instructions: "You are Sarah, a friendly assistant for Acme Final Expense. Keep replies to one short sentence.",
      turn_detection: { type: "server_vad" },
      audio: { output: { format: { type: "audio/pcmu" } } },
    },
  }));
  ws.send(JSON.stringify({
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text: "Hi, who is this?" }] },
  }));
  asked = Date.now();
  ws.send(JSON.stringify({ type: "response.create" }));
});

ws.on("message", (raw, isBinary) => {
  if (isBinary) { audioBytes += raw.length; firstAudio ??= Date.now(); return; }
  const ev = JSON.parse(raw);
  types.add(ev.type);
  if (ev.type === "error") done(`error: ${JSON.stringify(ev.error ?? ev)}`);
  if (/audio\.delta$/.test(ev.type)) { firstAudio ??= Date.now(); audioBytes += Buffer.from(ev.delta ?? "", "base64").length; }
  if (/audio_transcript\.delta$/.test(ev.type)) transcript += ev.delta;
  if (ev.type === "response.done") done("ok");
});
ws.on("unexpected-response", (_req, res) => done(`http ${res.statusCode}`));
ws.on("error", (e) => done(`ws error: ${e.message}`));
