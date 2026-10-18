import { env } from "./env.mjs";

export async function twilio(path, init = {}) {
  const sid = env("TWILIO_ACCOUNT_SID");
  const basic = Buffer.from(`${sid}:${env("TWILIO_AUTH_TOKEN")}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`, {
    ...init,
    headers: { Authorization: `Basic ${basic}`, ...init.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}
