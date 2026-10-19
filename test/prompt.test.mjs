import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { instructions } = await import("../src/prompt.mjs");

const SETTINGS = ["AI_DISCLOSURE", "COMPANY_NAME", "BOT_NAME", "AGENT_NAME", "CRM_BANK_IN_NOTE", "SCRIPT_EXTRA", "SCRIPT_OPENER_INBOUND", "SCRIPT_OPENER_REQUESTED_INFO"];
beforeEach(() => { for (const k of SETTINGS) delete process.env[k]; });

const introLine = (text) => text.split("\n").find((l) => l.startsWith("intro:"));
const SOURCES = ["requested_info", "tv_callback", "inbound"];

test("every source ends turns on a question and tells the bot to answer honestly if asked whether it is a person", () => {
  for (const disclosure of ["true", "false"]) for (const source of SOURCES) {
    process.env.AI_DISCLOSURE = disclosure;
    const t = instructions({ firstName: "Pat", state: "Ohio", source });
    assert.match(t, /your last sentence is a question\. Default to open-ended/, `${source} ${disclosure}`);
    assert.match(t, /answer honestly that you are a virtual assistant/, `${source} ${disclosure}`);
  }
});

test("with disclosure on the opener says the bot is a virtual assistant; off, it names only the bot and the company", () => {
  process.env.AI_DISCLOSURE = "true";
  assert.match(introLine(instructions({ firstName: "Pat", source: "requested_info" })), /^intro: "Hi, is this Pat\? This is Sarah, a virtual assistant with Acme Final Expense on a recorded line/);
  process.env.AI_DISCLOSURE = "false";
  const off = instructions({ firstName: "Pat", source: "requested_info" });
  assert.match(introLine(off), /This is Sarah with Acme Final Expense on a recorded line/);
  assert.doesNotMatch(introLine(off), /virtual assistant/);
  assert.match(off, /Don't introduce yourself as an assistant or AI/);
  process.env.AI_DISCLOSURE = "true";
  assert.doesNotMatch(instructions({ firstName: "Pat", source: "requested_info" }), /Don't introduce yourself as an assistant or AI/);
});

test("openers come from the script settings, with placeholders filled", () => {
  process.env.SCRIPT_OPENER_REQUESTED_INFO = "Hello {first}, {bot} from {company} here. {bot_intro}.";
  process.env.BOT_NAME = "Dana";
  process.env.COMPANY_NAME = "Maple Co";
  assert.match(introLine(instructions({ firstName: "Lee", source: "requested_info" })), /^intro: "Hello Lee, Dana from Maple Co here\. Dana, a virtual assistant with Maple Co\."/);
});

test("an inbound call never greets by a looked-up name and says they called us", () => {
  process.env.SCRIPT_OPENER_INBOUND = "Hi {first}! {bot_intro} here.";
  const t = instructions({ firstName: "Zelda", state: "Ohio", source: "inbound" });
  assert.doesNotMatch(t, /Zelda/);
  assert.match(t, /They called you/);
  assert.match(t, /You called us about final expense coverage/);
  assert.doesNotMatch(t, /Doesn't remember reaching out/, "someone who phoned in has no forgot line");
  assert.match(instructions({ source: "requested_info", firstName: "Pat" }), /Doesn't remember reaching out/);
});

test("the draft date comes from pick_draft_date, eligibility no longer asks the Social Security day, and a house number is read back by digit", () => {
  const t = instructions({ firstName: "Pat", source: "requested_info" });
  assert.match(t, /call pick_draft_date/);
  assert.match(t, /Never work out a date or weekday yourself/);
  assert.doesNotMatch(t, /what day Social Security arrives/);
  assert.match(t, /one digit at a time/);
});

test("asking for a person triggers transfer_to_agent, with a generic agent and no named one by default", () => {
  const t = instructions({ firstName: "Pat", source: "requested_info" });
  assert.match(t, /ask to speak with a real person[^]*call transfer_to_agent with reason "asked for a person"/);
  assert.match(t, /connecting you with a licensed agent now/);
  process.env.AGENT_NAME = "Jordan";
  assert.match(instructions({ firstName: "Pat", source: "requested_info" }), /connecting you with Jordan now/);
});

test("the SSN and bank reassurance makes no encryption or exclusivity claim, with or without bank details in the CRM note", () => {
  for (const flag of ["true", "false"]) {
    process.env.CRM_BANK_IN_NOTE = flag;
    const t = instructions({ firstName: "Pat", source: "requested_info" });
    assert.doesNotMatch(t, /encrypted/i, flag);
    assert.doesNotMatch(t, /only \S+ sees it/i, flag);
  }
});

test("owner's notes are appended only when set", () => {
  assert.doesNotMatch(instructions({ source: "inbound" }), /OWNER'S NOTES/);
  process.env.SCRIPT_EXTRA = "Never mention our other products.";
  const t = instructions({ source: "inbound" });
  assert.match(t, /\n\nOWNER'S NOTES\nNever mention our other products\.$/);
});
