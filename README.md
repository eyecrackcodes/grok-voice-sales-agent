# Grok Voice Sales Agent

Outbound and inbound final expense sales calls, run end to end by an AI voice agent. It uses Grok Voice 3.0 for the conversation and Twilio for the phone line. A live "Mission Control" dashboard shows every call as it moves through the script.

Demo video: https://youtu.be/O8i1qUW7UCs

The bot opens the call, qualifies the prospect, builds the case with NEPQ-style questions, prices three plan options, handles objections, takes the application (verified address, SSN and bank details through a secure section), and hands the finished file to a licensed human agent over a live transfer.

> **Disclaimer.** This software is provided as is, with no warranty. You are responsible for consent to call, insurance licensing, and protecting the data you collect. Read [COMPLIANCE.md](COMPLIANCE.md) and [SECURITY.md](SECURITY.md) before you call anyone other than yourself. Nothing here is legal advice.

## Features

- Full-cycle call script: intro, confirm, agenda, eligibility, discovery, coverage, health, needs recap, quote, price, objections, commit, application, recap, handoff.
- Server-enforced gates. The bot cannot quote before the prospect confirms the needs recap, and cannot hand off before the application is complete.
- Live Mission Control dashboard with stage map, transcript, objections and score.
- Secure capture of SSN and bank details: recording is paused, numbers go to an encrypted vault, and transcripts show only masked digits.
- Address verification against the Census geocoder and bank-name lookup from the routing number.
- Live transfer to a licensed agent, with a spoken whisper summary before they connect.
- Callback dialer with calling-window, attempt, daily-cap and voicemail handling.
- Pluggable CRM: a CSV and JSONL adapter by default, an optional hosted-CRM adapter, and a small interface for your own.
- Practice mode: a Grok-played prospect calls the bot in text, with four personas, plus a grader for the NEPQ questioning.
- Demo mode on by default. It dials only the numbers you list.
- A Settings page for everything: keys, phone numbers, names, voice, hours, limits, transfers, CRM and the script's openers. No file editing, and keys are always masked.
- Inbound calls: the bot answers your Twilio number within the hours and daily limit you set, and sends anything it can't take to a fallback number. It works with call platforms that forward calls to an outside number.
- Every turn ends on a question, open-ended by default, so the prospect is never left wondering whether to talk.
- First draft dates are worked out by the server from the date of birth (the Social Security payment schedule, shifted for weekends and holidays), never by the model.
- CRM notes during the call, not only at the end: the lead is updated after the needs and health questions, after the quote and after the application.
- Transfers to a person (with a spoken summary first) or to a call queue (straight through, showing the caller's number).
- AI disclosure on by default, with a switch on the Settings page.

## Prerequisites

- Node 20 or newer
- An xAI API key with Grok Voice access
- A Twilio account with a voice-capable phone number
- A public https address Twilio can reach: run it on a server with Docker ([docs/deploy.md](docs/deploy.md)), or on your computer through a tunnel such as [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

## Quickstart

These steps place one test call to your own phone. Commands work in Windows PowerShell and macOS Terminal unless noted.

1. Clone and install.

   ```
   git clone https://github.com/eyecrackcodes/grok-voice-sales-agent.git
   cd grok-voice-sales-agent
   npm install
   ```

2. Start the server.

   ```
   npm start
   ```

   It prints the Settings address. On first start it creates `VAULT_KEY`, the key that encrypts SSN and bank details, in `data/settings.json`. Back that file up.

3. In a second terminal, start the tunnel so Twilio can reach your computer.

   ```
   cloudflared tunnel --url http://127.0.0.1:4319 --logfile data/tunnel.log
   ```

   The app reads the `https://something.trycloudflare.com` address from `data/tunnel.log`. If you run your own server or tunnel, enter its address on the Settings page instead.

4. Open http://127.0.0.1:4319/settings in your browser. The setup checklist at the top lists what is missing. Fill in your xAI API key, your Twilio Account SID, Auth Token and phone number, your own cell under **Numbers the bot may call while testing**, and a transfer number. Select **Save**, then use the **Test** buttons to check each connection. In demo mode the bot refuses every number that is not on the test list.

5. When the checklist is complete, a **Place a test call** row appears in it. Your test number is already filled in. Add a first name, select **Call my phone** and confirm. Your phone rings. Answer, and use the link beside the button to watch the call move through the stages in Mission Control. The gear icon in its header goes back to Settings.

   A call costs about $0.08 a minute for Grok Voice plus Twilio's per-minute rate. To place the same call from a terminal instead, run `node scripts/call-lead.mjs --phone +1YOURNUMBER --name You`.

Settings are saved in `data/settings.json`. A `.env` file still works. Copy `.env.example` to `.env` and fill it in. A value saved on the Settings page takes priority over `.env`. A variable set in the server's own environment, for example with `docker run -e`, takes priority over both, and the Settings page shows it as locked.

If a step fails, the error message names the missing setting. A call to a number that is not in `DIAL_ALLOWLIST` is refused with a log line that says why.

## How it works

The server accepts the Twilio media stream, runs one Grok Voice session per call, and records every accepted event in a hub that feeds the dashboard. The bot drives the call through ten tools (stage, facts, quote, draft date, address check, secure mode, sensitive data, transfer, objection, end). The server validates each move against the gates in `src/flow.mjs`.

See [docs/architecture.html](docs/architecture.html) for the component diagram, the call sequence, the data schema, and a table of gates, outcomes and where data lives. Diagram sources are in `docs/diagrams/*.mmd`; `npm run diagrams` redraws them.

## Customizing the script and flow

- The openers for each kind of call, and any extra instructions for the bot, are on the Settings page under Script. Placeholders such as `{first}` and `{company}` are filled in on every call.
- `src/prompt.mjs` holds the whole script the bot follows: tone, the NEPQ questioning approach, price presentation, objection answers and the application steps. Edit the wording freely. Business names, the carrier line and the agent's name come from the Settings page, not the prompt.
- `src/flow.mjs` defines the stages, the facts the bot may save, and the gates. Each stage has a `requires` list of facts the server checks before it allows entry. Add a fact, then add it to the `requires` of the stage that depends on it, and the bot cannot skip it.
- `src/call-state.mjs` folds the event log into call state. It is pure, so replays and tests run the same code as live calls.
- Replay a recorded call on the dashboard with `npm run sim -- sim/fe-happy-path.json`. This costs nothing.

## Inbound calls

1. On the Settings page, open **Inbound calls**, switch on **Let the bot answer calls to your Twilio number**, and set the hours, the daily limit and the fallback number.
2. Press **Point my Twilio number at this server**. It sets the number's webhook to this server and the fallback to your fallback number, so callers still reach a person if the server is down. That server-down fallback uses Twilio's Twimlets forwarding service, so Twilio's twimlets.com sees the fallback number.
3. Call your Twilio number.

The bot asks every inbound caller's name and never greets them by a name it looked up. **Look up callers in the CRM** decides which lead gets the application: any lead with the caller's number, only a lead created in the last 30 minutes (for call platforms that post a new lead for each call), or none.

## Checking how the bot talks

`node scripts/turn-audit.mjs data/calls/<call id>.jsonl` lists every turn where the bot stopped on a statement and left the prospect waiting, and every yes/no question it asked outside the parts of the call that collect facts. Run it after a test call to see whether a script change helped.

## Loading your own rates

The quote engine reads one JSON file, set with `RATE_TABLE`. The shipped `src/rates/sample-level-plan.json` is **sample data, not real rates**. Replace it with a table you are licensed and permitted to use. Check the terms of your carrier agreement before you put agent-only rate sheets in a repository or share them.

```json
{
  "source": "where this table came from",
  "plan": "Plan name spoken in quotes",
  "unit": "annual premium per $1,000",
  "policyFeeAnnual": 30,
  "modalMonthly": 0.088,
  "rates": {
    "50": { "M": { "N": 22.0, "T": 29.7 }, "F": { "N": 17.6, "T": 21.47 } },
    "51": { "M": { "N": 23.28, "T": 31.43 }, "F": { "N": 18.62, "T": 22.72 } }
  }
}
```

Keys under `rates` are ages. `M` and `F` are male and female. `N` is non-tobacco and `T` is tobacco. Annual premium is `rate x face / 1000 + policyFeeAnnual`. Monthly premium is that annual figure times `modalMonthly`, rounded to cents. Ages missing from the table are refused. Set `CARRIER_NAME` and `CARRIER_BLURB` so the bot's credibility line matches the carrier of your table.

## CRM adapters

Pick the CRM on the Settings page (or set `CRM_PROVIDER` in `.env`), then restart the server.

- `none` (default). Leads come from `data/leads.csv` with the columns `id, first_name, last_name, phone, state, timezone, dnc`. On first run the file is copied from `data/leads.example.csv`, which holds one fake lead with a 555 number. Handoffs and outcomes are appended to `data/outcomes.jsonl`. SSN and bank details are never written there, only the masked values. A `dnc` outcome blocks the lead from future dialing.
- `dsb`. An optional adapter for a hosted CRM (Digital Senior Benefits) with a tool-call HTTP API. It needs `DSB_BASE`, `DSB_CRM_MCP`, `CRM_CARRIER_ID` and `CRM_PRODUCT_ID`. Status ids and field names are that CRM's own. Use a token with the least privilege that works.
- Your own. Add `src/crm/<name>.mjs` and register it in `src/crm/index.mjs`. An adapter exports `listQueue()`, `getLead(id)`, `writeHandoff({ lead, state, status })`, `writeOutcome({ lead, state })` and `addNote(lead, text)`. A lead is `{ id, first_name, last_name, phone, state, timezone, dnc }`. `src/crm/none.mjs` is the shortest reference.

To call a lead from the queue, run `node scripts/call-lead.mjs <lead id>`. To start the callback dialer, send `POST /dialer/start` from the dashboard.

## Costs

A call costs about $0.08 per minute for Grok Voice, plus Twilio per-minute pricing for the outbound call and recording. Check both providers' current price pages, because rates change. `MAX_CALL_MINUTES` (default 20) caps the length of any one call.

## Safety caps

- Demo mode: without `CONSENT_CONFIRMED=true`, the bot dials only numbers in `DIAL_ALLOWLIST`. Both `placeCall` and the dialer enforce this.
- `CONSENT_CONFIRMED=true` turns the allowlist off and logs a warning that you are responsible for consent, DNC scrubbing and calling hours.
- `MAX_CALL_MINUTES`: hard cap on billed voice minutes per call.
- `DIALER_MAX_CALLS_PER_DAY`: daily cap for the callback dialer (default 25).
- `PRACTICE_MAX_ACTIVE`: practice calls allowed at once (default 2).
- Calling window: the dialer calls only between 9 AM and 8 PM in the lead's time zone, and leads with a `dnc` flag are skipped.

## Practice mode and its cost

Practice mode runs the real bot against a Grok-played prospect in text, so you can test script changes without a phone call. Start one from the dashboard, or run `node scripts/roleplay.mjs dorothy earl`. Personas are in `sim/personas.json`.

Practice calls spend real xAI credit, about $0.08 per minute of Grok Voice plus the prospect model's tokens. `scripts/eval-discovery.mjs` repeats each persona several times and grades each call several times, so it multiplies that cost. Decide the spend before you run it. `scripts/grade-call.mjs` grades a call log with a built-in NEPQ finesse rubric. Set `GRADER_RUBRIC_FILE` to add your own rubric items.

## Tests

```
npm test
```

The tests cover the call-state gates, rate math, the Twilio signature check, dashboard token access, the settings store, validation and API (with stubbed xAI, Twilio and CRM calls), the dial allowlist, the CSV adapter, and the SSN, routing and account number checks. They make no network calls.

## Project layout

- `src/` server, bridge, session, prompt, flow, call state, quote, vault, verify, dialer, config
- `src/crm/` CRM adapters
- `src/rates/` rate tables
- `scripts/` call, practice, grading and diagram scripts
- `public/` dashboards and the Settings page
- `docs/` architecture page and diagram sources
- `sim/` replayable call scripts and practice personas
- `test/` unit tests

## License

MIT. See [LICENSE](LICENSE). Read the disclaimer at the top of this file.
