// Rerunnable check of how the bot ends its turns, over a call's event log.
//   node scripts/turn-audit.mjs data/calls/<callId>.jsonl
// deadAir: the bot stopped on a statement and the prospect had to guess it was their turn.
// closed: the bot ended on a yes/no question outside the stages where a short answer is the goal.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const DATA_CAPTURE_STAGES = ["eligibility", "health", "application", "recap"];
const SECURE = "[secure entry, not shown]";
const YES_NO = /^(?:(?:and|so|now|okay|ok|alright)[,\s]+)*(?:do|does|did|is|are|can|could|would|will|have|has)\b/i;
// "A or B" asks for a pick, not a yes or no.
const isYesNo = (s) => YES_NO.test(s) && !/\bor\b/i.test(s);

const lastSentence = (text) => String(text).trim().split(/(?<=[.!?])\s+/).filter(Boolean).pop() ?? "";

export function auditTurns(events) {
  const turns = [];
  let stage = "dialing", open = null;
  const close = (next) => {
    if (open) turns.push({ ...open, next });
    open = null;
  };
  for (const e of events) {
    if (e.type === "stage") stage = e.to;
    else if (e.type === "transcript" && e.speaker === "bot") {
      open ??= { lines: [], at: e.at };
      open.lines.push(e.text);
      open.stage = stage;
    } else if (e.type === "transcript") close(e);
  }
  close(null);

  const deadAir = [], closed = {}, flagged = [];
  turns.forEach((t, i) => {
    const text = t.lines.join(" ");
    const sentence = lastSentence(text);
    const isQuestion = sentence.endsWith("?");
    const entry = { stage: t.stage, at: t.at, text: sentence };
    const last = i === turns.length - 1;
    if (!isQuestion && t.next?.speaker === "prospect" && t.next.text !== SECURE && !last) deadAir.push(entry);
    if (isQuestion && isYesNo(sentence)) {
      (closed[t.stage] ??= []).push(entry);
      if (!DATA_CAPTURE_STAGES.includes(t.stage)) flagged.push(entry);
    }
  });
  return { turns: turns.length, deadAir, closed, flagged };
}

export function formatAudit(r) {
  const byStage = Object.entries(r.closed).map(([s, l]) => `${s} ${l.length}`).join(", ") || "none";
  return [
    `bot turns: ${r.turns}`,
    `dead air: ${r.deadAir.length}`,
    ...r.deadAir.map((x) => `  [${x.stage}] ${x.text}`),
    `closed yes/no questions by stage: ${byStage}`,
    `closed outside data-capture stages: ${r.flagged.length}`,
    ...r.flagged.map((x) => `  [${x.stage}] ${x.text}`),
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) { console.error("usage: node scripts/turn-audit.mjs <path-to-jsonl>"); process.exit(1); }
  const events = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log(formatAudit(auditTurns(events)));
}
