import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { twilioSignature, validTwilioSignature } from "../src/twilio-signature.mjs";
import { authorize } from "../src/dashboard-auth.mjs";
import { isLoopbackHost } from "../src/config.mjs";

const url = "https://example.trycloudflare.com/twiml/whisper?callId=call-1&secret=abc";
const params = { To: "+15555550123", CallSid: "CA123", AnsweredBy: "human" };
const token = "test-auth-token";

test("signature matches an HMAC-SHA1 built by hand: url, then keys sorted, each key followed by its value", () => {
  const data = `${url}AnsweredByhumanCallSidCA123To+15555550123`;
  const expected = createHmac("sha1", token).update(data).digest("base64");
  assert.equal(twilioSignature(url, params, token), expected);
  assert.equal(twilioSignature(url, { To: params.To, AnsweredBy: params.AnsweredBy, CallSid: params.CallSid }, token), expected, "param order does not matter");
});

test("signature matches the worked example in Twilio's security documentation", () => {
  const sig = twilioSignature("https://mycompany.com/myapp.php?foo=1&bar=2", {
    CallSid: "CA1234567890ABCDE", Caller: "+14158675309", Digits: "1234", From: "+14158675309", To: "+18005551212",
  }, "12345");
  assert.equal(sig, "RSOYDt4T1cUTdK1PDd93/VVr8B8=");
});

test("validation accepts the right signature and rejects missing, wrong, or altered requests", () => {
  const good = twilioSignature(url, params, token);
  assert.equal(validTwilioSignature(good, url, params, token), true);
  assert.equal(validTwilioSignature(undefined, url, params, token), false);
  assert.equal(validTwilioSignature("", url, params, token), false);
  assert.equal(validTwilioSignature(good.slice(0, -2) + "xx", url, params, token), false);
  assert.equal(validTwilioSignature(good, url.replace("secret=abc", "secret=abd"), params, token), false);
  assert.equal(validTwilioSignature(good, url, { ...params, To: "+15555550199" }, token), false);
  assert.equal(validTwilioSignature(good, url, params, "other-token"), false);
  assert.equal(validTwilioSignature(good, url, params, ""), false, "no auth token configured fails closed");
});

test("websocket signatures cover the wss URL with no params", () => {
  const wss = "wss://example.trycloudflare.com/twilio-stream";
  assert.equal(validTwilioSignature(twilioSignature(wss, {}, token), wss, {}, token), true);
});

const req = (headers = {}) => ({ headers: { host: "127.0.0.1:4319", ...headers } });
const at = (path) => new URL(path, "http://localhost");

test("with a token set, requests need a bearer header, ?token=, or the cookie, and the query visit sets the cookie", () => {
  assert.equal(authorize(req(), at("/v2"), "s3cret").ok, false);
  assert.equal(authorize(req({ authorization: "Bearer wrong" }), at("/v2"), "s3cret").status, 401);
  assert.equal(authorize(req({ authorization: "Bearer s3cret" }), at("/calls"), "s3cret").ok, true);
  const visit = authorize(req(), at("/v2?token=s3cret"), "s3cret");
  assert.equal(visit.ok, true);
  assert.match(visit.setCookie, /HttpOnly/);
  assert.match(visit.setCookie, /SameSite=Strict/);
  assert.equal(authorize(req({ cookie: "x=1; dash_token=s3cret" }), at("/stream"), "s3cret").ok, true);
  assert.equal(authorize(req({ cookie: "dash_token=nope" }), at("/stream"), "s3cret").ok, false);
});

test("with no token, only loopback hosts and same-origin posts get through", () => {
  assert.equal(authorize(req(), at("/v2"), "").ok, true);
  assert.equal(authorize(req({ host: "evil.example" }), at("/v2"), "").ok, false, "DNS rebinding");
  assert.equal(authorize(req({ origin: "http://evil.example" }), at("/dialer/start"), "").ok, false, "cross-site post");
  assert.equal(authorize(req({ origin: "http://127.0.0.1:4319" }), at("/dialer/start"), "").ok, true);
});

test("loopback detection", () => {
  for (const h of ["127.0.0.1", "localhost", "::1", "127.1.2.3"]) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["0.0.0.0", "192.168.1.5", "::", "example.com"]) assert.equal(isLoopbackHost(h), false, h);
});

test("a null or malformed Origin is refused, never thrown", async () => {
  const { authorize } = await import("../src/dashboard-auth.mjs");
  const url = new URL("http://127.0.0.1:4319/v2");
  for (const origin of ["null", "not a url", "http://evil.example"])
    assert.equal(authorize({ headers: { host: "127.0.0.1:4319", origin } }, url, "").status, 403, origin);
});
