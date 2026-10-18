# Compliance

This page is a plain-language orientation, **not legal advice**. Telemarketing, insurance and privacy rules change and vary by state. They apply to you as the person who places the calls, not to the software. Talk to a qualified attorney and your carrier's compliance team before you call anyone other than yourself. The points below are general and may be incomplete or out of date.

Demo mode exists because of this page. By default the bot dials only the numbers in `DIAL_ALLOWLIST`. Setting `CONSENT_CONFIRMED=true` turns that off and means you have handled everything below.

## Consent to call (TCPA)

In February 2024 the FCC issued a declaratory ruling that treats AI-generated voices as "artificial" under the Telephone Consumer Protection Act. In general, that means marketing calls that use an AI voice need the called person's prior express written consent. Consent usually has to be specific to your company, recorded in a form you can produce, and not a condition of buying anything. Leads you bought, scraped or inherited are often not enough on their own. Check how each lead's consent was captured, and keep the proof.

## Do-not-call lists

Check the National Do Not Call Registry, any state do-not-call lists that apply to your leads, and your own internal do-not-call list before you dial. If someone asks not to be called, record it and honor it. The bot flags a spoken request to stop as a `dnc` outcome, and the default CSV adapter blocks that lead from later dialing. That is a minimal internal list, not a substitute for scrubbing against the registries. Ask your attorney how consent and registry listings interact for your leads.

## Calling hours

Federal rules generally limit telemarketing calls to between 8 AM and 9 PM in the called party's local time. Some states are stricter. Florida, for example, limits calls to 8 AM to 8 PM and also limits how often a person may be called. Other states have their own hours, holidays and frequency limits. The dialer defaults to 9 AM to 8 PM in the lead's time zone, which fits inside the federal window and the stricter ones some states use. It trusts the `timezone` in your lead data, so a wrong time zone defeats it. Check the rules for every state you call.

## Recording the call

About a dozen states require every party's consent before a call is recorded, including California, Florida, Illinois, Maryland, Massachusetts, Pennsylvania and Washington. Others require only one party's consent. The call may cross state lines, and the stricter rule often governs. The bot says it is on a recorded line at the start of every call, and Twilio records the call. Whether that disclosure and the prospect's continued participation meet each state's standard is for you and your attorney to decide. The bot pauses the recording during the SSN and bank sections.

## Disclosing that it is an AI

Some states and some carriers require you to say that a caller is an automated or AI system. The bot introduces itself as a virtual assistant and says so again if asked whether it is a real person. Laws in this area are new and change quickly, so check the current rules for each state you call and update the script in `src/prompt.mjs` if they require different wording.

## Insurance licensing

The AI is not a licensed insurance agent. It gathers information, quotes from a rate table and prepares an application. A licensed human agent must finish the conversation, review the application, and submit it, which is why the call ends in a live transfer. Whoever sells insurance must hold a license in the prospect's state and be appointed with the carrier. Quotes and statements made by the bot could count as insurance advertising or sales activity in some states. Review the script against your state's rules and your carrier's marketing guidelines.

## SSN and bank data

Collecting Social Security numbers and bank account details brings legal duties. In the United States, the Gramm-Leach-Bliley Act's Safeguards Rule generally requires financial institutions and many insurance businesses to keep a written security program and protect customer information. The NACHA operating rules require parties that store ACH account numbers to protect them, for example by making them unreadable when stored. State privacy and breach-notification laws can also apply. This project encrypts sensitive values in a vault for 72 hours, masks them in logs, and pauses recordings, but encryption in the software does not make your business compliant. You are also responsible for the places data goes: your voice provider hears spoken numbers, your CRM stores what you send it, and Twilio keeps what it records. See [SECURITY.md](SECURITY.md).

## Carrier materials

Rate tables, agent guides and scripts that a carrier gives you are usually covered by your agreement with them and are often marked for agent use only. Do not publish or share them without permission. The `src/rates/sample-level-plan.json` table in this repository is made-up sample data. Replace it with a table you may lawfully use, and keep it out of any public copy of the project. Carriers may also require approval of scripts, call recordings and AI use before you run it on their products.

## Your checklist before dialing a stranger

1. A written consent record for each number, with the right company named.
2. Scrubbing against the National list, your state lists and your internal list.
3. Correct time zones and calling hours, including state limits.
4. A recording disclosure and consent approach that fits every state you call.
5. An AI disclosure that fits the rules where you call.
6. A licensed agent, appointed with the carrier, ready for every transfer.
7. A written plan for protecting SSN and bank data, plus a review of each provider's data terms.
8. Review by an attorney.
