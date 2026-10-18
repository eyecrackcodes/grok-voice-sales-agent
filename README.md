# Grok Voice Sales Agent

An outbound final expense sales call, run end to end by an AI voice agent. It uses Grok Voice 3.0 for the conversation and Twilio for the phone line. A live "Mission Control" dashboard shows every call as it moves through the script.

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

## Prerequisites

- Node 20 or newer
- An xAI API key with Grok Voice access
- A Twilio account with a voice-capable phone number
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for the tunnel Twilio uses to reach your computer

## Quickstart

These steps place one test call to your own phone. Commands work in Windows PowerShell and macOS Terminal unless noted.

1. Clone and install.

   ```
   git clone https://github.com/eyecrackcodes/grok-voice-sales-agent.git
   cd grok-voice-sales-agent
   npm install
   ```

2. Create your settings file.

   ```
   # macOS or Linux
   cp .env.example .env
   # Windows PowerShell
   copy .env.example .env
   ```

3. Open `.env` in a text editor and fill in `X_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_PHONE_NUMBER`. Generate a `VAULT_KEY` and paste it in:

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

4. Put your own phone number in `DIAL_ALLOWLIST` in E.164 form, for example `+15125550123`. In demo mode the bot refuses every number that is not listed.

5. Start the server.

   ```
   npm start
   ```

   It prints the dashboard address and warns about any missing keys.

6. Open http://127.0.0.1:4319/v2 in your browser.

7. In a second terminal, start the tunnel and log it to `data/tunnel.log`. The app reads the public address from that file.

   ```
   cloudflared tunnel --url http://127.0.0.1:4319 --logfile data/tunnel.log
   ```

   Wait until `data/tunnel.log` contains a `https://something.trycloudflare.com` address. Alternatively set `PUBLIC_BASE` in `.env` to your own tunnel address and restart.

8. In a third terminal, place the call.

   ```
   node scripts/call-lead.mjs --phone +1YOURNUMBER --name You
   ```

   Your phone rings. Answer, and watch the call move through the stages on the dashboard.

If a step fails, the error message names the missing setting. A call to a number that is not in `DIAL_ALLOWLIST` is refused with a log line that says why.

## How it works

The server accepts the Twilio media stream, runs one Grok Voice session per call, and records every accepted event in a hub that feeds the dashboard. The bot drives the call through nine tools (stage, facts, quote, address check, secure mode, sensitive data, transfer, objection, end). The server validates each move against the gates in `src/flow.mjs`.

See [docs/architecture.html](docs/architecture.html) for the component diagram, the call sequence, the data schema, and a table of gates, outcomes and where data lives. Diagram sources are in `docs/diagrams/*.mmd`; `npm run diagrams` redraws them.

## Customizing the script and flow

- `src/prompt.mjs` holds the whole script the bot follows: tone, the NEPQ questioning approach, price presentation, objection answers and the application steps. Edit the wording freely. Business names, the carrier line and the agent's name come from `.env`, not the prompt.
- `src/flow.mjs` defines the stages, the facts the bot may save, and the gates. Each stage has a `requires` list of facts the server checks before it allows entry. Add a fact, then add it to the `requires` of the stage that depends on it, and the bot cannot skip it.
- `src/call-state.mjs` folds the event log into call state. It is pure, so replays and tests run the same code as live calls.
- Replay a recorded call on the dashboard with `npm run sim -- sim/fe-happy-path.json`. This costs nothing.

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

Set `CRM_PROVIDER` in `.env`.

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

The tests cover the call-state gates, rate math, the Twilio signature check, dashboard token access, the dial allowlist, the CSV adapter, and the SSN, routing and account number checks. They make no network calls.

## Project layout

- `src/` server, bridge, session, prompt, flow, call state, quote, vault, verify, dialer, config
- `src/crm/` CRM adapters
- `src/rates/` rate tables
- `scripts/` call, practice, grading and diagram scripts
- `public/` dashboards
- `docs/` architecture page and diagram sources
- `sim/` replayable call scripts and practice personas
- `test/` unit tests

## License

MIT. See [LICENSE](LICENSE). Read the disclaimer at the top of this file.
