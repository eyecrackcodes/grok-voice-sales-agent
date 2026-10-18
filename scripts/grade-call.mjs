// Grades a practice or live call's event log with a built-in NEPQ finesse rubric,
// plus any rubric you supply in GRADER_RUBRIC_FILE.
// COST WARNING: each graded call is one or more grok-4.3 requests; grading many calls adds up.
//   node scripts/grade-call.mjs data/calls/<callId>.jsonl [more.jsonl ...]
import { readFileSync } from "node:fs";
import { env } from "./env.mjs";

// Optional extra rubric: GRADER_RUBRIC_FILE points at JSON shaped like
// { "items": [{ "title": "Discovery", "prompt": "grader instructions; end the reply with <score>N</score>" }] }
// (a { "scorecard": { "items": [{ title, expertPrompt }] } } file works too). Without it, only the built-in finesse rubric runs.
const rubricFile = process.env.GRADER_RUBRIC_FILE;
const RUBRIC = rubricFile
  ? (() => {
      const raw = JSON.parse(readFileSync(rubricFile, "utf8"));
      return (raw.items ?? raw.scorecard?.items ?? []).map((i) => ({ title: i.title, prompt: i.prompt ?? i.expertPrompt }));
    })()
  : [];

const FINESSE = `You are a sales coach expert in NEPQ (Jeremy Miner / 7th Level) questioning, evaluating how an AI agent built the case for final expense insurance with a senior prospect.
Score the DISCOVERY and NEEDS portion only (from marital/family questions through the coverage amount). Ignore exact-duplicate sentence fragments; they are a transcription artifact.
Return JSON with:
- finesse (1-5): 5 = calm, curious, neutral questions; the prospect states the problem and consequence in their own words; agent clarifies ("how so?", "what do you mean by that?", "tell me more") and reflects briefly; emotional moments acknowledged without lingering; nothing preachy, dramatic, or manipulative. 1 = agent lectures, dramatizes death or grief, tells the prospect how they should feel, or stacks heavy questions.
- self_persuasion (1-5): how much of the pain and the "why" was said BY THE PROSPECT vs supplied by the agent.
- drama_risk (1-5): 5 = high risk the prospect disengages because it felt heavy-handed, salesy, or morbid.
- questions_vs_statements: rough count of agent turns in discovery that ended with a question vs agent turns that were statements, as "Q/S".
- stacked_questions: count of agent turns asking more than one question.
- best_moment: the single best agent line verbatim.
- worst_moment: the single weakest agent line verbatim, and why.
- fix: one concrete change to the agent's approach.`;

async function grok(system, user, json) {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("X_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "grok-4.3", temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }],
      ...(json ? { response_format: { type: "json_object" } } : {}) }),
  });
  if (!res.ok) throw new Error(`grader ${res.status}`);
  return (await res.json()).choices[0].message.content;
}

export async function gradeLog(path) {
  const events = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const name = events[0].lead?.name ?? "Prospect";
  const transcript = events.filter((e) => e.type === "transcript")
    .map((e) => `${e.speaker === "bot" ? "Agent (bot)" : `Prospect (${name})`}: ${e.text}`).join("\n");
  const outcome = [...events].reverse().find((e) => e.type === "stage")?.to;
  const [fin, ...extra] = await Promise.all([
    grok(FINESSE, `TRANSCRIPT\n${transcript}`, true),
    ...RUBRIC.map((item) => grok(item.prompt, `TRANSCRIPT\n${transcript}`)),
  ]);
  const score = (s) => s.match(/<score>\s*([^<]+?)\s*<\/score>/)?.[1] ?? "?";
  const rubric = Object.fromEntries(RUBRIC.map((item, i) => [item.title, score(extra[i])]));
  return { call: path.split(/[\\/]/).pop().replace(".jsonl", ""), outcome, rubric, finesse: JSON.parse(fin),
    discovery: rubric.Discovery ?? null, needs: rubric["Needs Analysis"] ?? null };
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const results = await Promise.all(process.argv.slice(2).map(gradeLog));
  for (const r of results) {
    const f = r.finesse;
    console.log(`${r.call.padEnd(26)} outcome=${String(r.outcome).padEnd(10)} ${Object.entries(r.rubric).map(([k, v]) => `${k}=${v}`).join(" ")} finesse=${f.finesse} self-persuasion=${f.self_persuasion} drama-risk=${f.drama_risk} Q/S=${f.questions_vs_statements} stacked=${f.stacked_questions}`);
    console.log(`   best:  ${f.best_moment}`);
    console.log(`   worst: ${typeof f.worst_moment === "string" ? f.worst_moment : JSON.stringify(f.worst_moment)}`);
    console.log(`   fix:   ${f.fix}`);
  }
}
