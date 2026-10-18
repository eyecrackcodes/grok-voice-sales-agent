// X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + each POST param key and value, keys sorted)).
// `url` is the full URL exactly as Twilio requested it, query string included.
import { createHmac, timingSafeEqual } from "node:crypto";

export function twilioSignature(url, params, authToken) {
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function validTwilioSignature(header, url, params, authToken) {
  if (!header || !authToken) return false;
  const given = Buffer.from(String(header));
  const expected = Buffer.from(twilioSignature(url, params, authToken));
  return given.length === expected.length && timingSafeEqual(given, expected);
}
