# Security

This project handles phone audio, Social Security numbers and bank details. Read this page before you use it with anyone's real data. It describes what the code does, what it leaves to you, and how to report a problem.

## Threat model

The software runs on one computer you control. Three parties can reach it: you (the dashboard), Twilio (call audio and callbacks) and the internet at large (through the tunnel). The design keeps each party to its own routes.

**Dashboard.** The server binds to `127.0.0.1` by default, so only programs on your computer can reach the dashboard, the event API and the call logs. When `DASHBOARD_TOKEN` is set, every non-Twilio route also needs it, as an `Authorization: Bearer` header, a `?token=` query, or the HttpOnly, SameSite=Strict cookie the server sets after a valid `?token=` visit. The server refuses to start if `HOST` is not a loopback address and `DASHBOARD_TOKEN` is unset. Without a token, the server also rejects requests whose `Host` header is not loopback (DNS rebinding) and POSTs whose `Origin` is another site. Do not expose the dashboard to the internet. Use a long random token if you bind it to a LAN address.

**Tunnel.** Anything that arrives through the Cloudflare tunnel (it carries a `cf-connecting-ip` header) can reach only three paths: `/twilio-stream`, `/twiml/whisper` and `/twilio/amd`. Everything else returns 404 on the tunnel. The two HTTP routes require a valid `X-Twilio-Signature`, computed as Twilio documents (HMAC-SHA1 with your auth token over the full URL and sorted POST parameters, compared in constant time), and a per-process random secret that changes on every start. A missing or wrong signature gets a 403. The media stream always checks the secret passed in the stream's start parameters. It also checks `X-Twilio-Signature` when Twilio sends it, but by default only logs a warning on a mismatch, because that check has not been verified against live media-stream traffic; set `TWILIO_STREAM_SIGNATURE=enforce` to reject instead. `TWILIO_SIGNATURE_CHECK=off` disables the HTTP signature check for troubleshooting only. The signature check needs the public tunnel address, which comes from `PUBLIC_BASE` or `data/tunnel.log`. If it cannot be found, requests fail closed.

**Settings page.** For long secrets such as API keys, the Settings page shows the last 4 characters to anyone signed in to the dashboard. Set the dashboard password before you expose the server to anything but your own computer, and treat everyone with that password as able to see those characters.

**Dialing.** Demo mode (the default) lets the bot dial only numbers in `DIAL_ALLOWLIST`. Turning it off with `CONSENT_CONFIRMED=true` is a statement that you hold consent for every number. See [COMPLIANCE.md](COMPLIANCE.md).

## Where secrets live

- API keys and tokens (`X_API_KEY`, `TWILIO_*`, `DSB_*`, `DASHBOARD_TOKEN`) live in `.env`, which `.gitignore` excludes. Never commit it. Rotate any key that has been pasted into a chat, a screenshot or a log.
- SSN and bank details live only in the vault, `data/vault/*.enc`. Each record is encrypted with AES-256-GCM under `VAULT_KEY` (32 random bytes, base64). Records are deleted 72 hours after their last update. Losing `VAULT_KEY` makes the vault unreadable. Anyone who has both the key and the files can read the contents, so keep them on separate trust boundaries where you can.
- Call state, the event log and transcripts hold only masked values, such as the last four digits.
- The default CRM adapter writes masked values only to `data/outcomes.jsonl`. A hosted CRM adapter may send the SSN to that CRM's encrypted field. Bank details never leave the vault.
- Everything under `data/` is excluded from git, except the example lead file. It can still contain names, addresses and call transcripts. Treat that folder as personal data.

## Digit masking

Runs of seven or more digits are replaced with `[#]` in saved facts, the live transcript and logs. While secure mode is on, prospect speech is replaced with `[secure entry, not shown]`. Tool logs for the sensitive-data tool list field names, never values. Masking is a safety net, not a guarantee, and a speech recognizer can split a number in ways a pattern misses.

## What the voice provider hears

The prospect speaks the SSN and bank details aloud, so the voice provider (xAI) receives that audio and its transcript while the call is live. Masking cannot change that. Check the provider's data retention, logging and training terms before you collect these items, and decide whether your policies allow it. The address and routing-number checks also send data to public services: the address to the US Census geocoder, and the routing number to a public bank directory.

## Recordings

Twilio records the call. The bot pauses the recording before it asks for the SSN or bank details and resumes it afterward, so those numbers stay out of the recording. If the pause request fails, the failure is logged but the call continues, so watch your logs. Recordings stay in your Twilio account under its retention settings. The bot discloses the recorded line at the start of each call, but recording-consent law is yours to follow. See [COMPLIANCE.md](COMPLIANCE.md).

## Least-privilege CRM tokens

Give a CRM adapter the narrowest token that works: read and update on leads, notes and statuses, scoped to the lead queue the bot works, and nothing for billing, users or deletion. Restrict the token by IP address if the CRM supports it. Create a separate token for testing.

## Limits of this review

The code has unit tests for the signature check, token access, the dial gate and the CSV adapter. It has had no independent security audit. Run your own review and a penetration test before you handle real customer data at scale.

## Reporting a vulnerability

Please report security problems privately and do not open a public issue. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). If that is unavailable, contact the repository owner, eyecrackcodes, through the contact details on the GitHub profile. Include the steps to reproduce, the version or commit, and the impact you see. Do not include real customer data. Expect an acknowledgement within a few days. This is a free project maintained on a best-effort basis, with no guaranteed fix time.
