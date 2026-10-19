// Access control for the dashboard and event API (every non-Twilio route).
// With DASHBOARD_TOKEN set, a request must carry it as `Authorization: Bearer`,
// a `?token=` query, or the HttpOnly cookie the server sets after a valid
// `?token=` visit, so the HTML pages and EventSource work without changes.
import { createHash, timingSafeEqual } from "node:crypto";
import { isLoopbackHost } from "./config.mjs";

const digest = (v) => createHash("sha256").update(String(v)).digest();
export const tokensEqual = (a, b) => timingSafeEqual(digest(a), digest(b));

const COOKIE = "dash_token";
// An empty token expires the cookie.
export const sessionCookie = (token) => (token
  ? `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`
  : `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
const cookieValue = (req) => {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};

const hostname = (hostHeader) => {
  const h = String(hostHeader ?? "");
  return h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
};

// Returns { ok, status, setCookie }. `token` empty means the dashboard is open, which only
// the loopback bind allows; then the Host and Origin checks stop DNS rebinding and cross-site POSTs.
export function authorize(req, url, token) {
  if (!token) {
    if (!isLoopbackHost(hostname(req.headers.host))) return { ok: false, status: 403 };
    const origin = req.headers.origin;
    if (origin) {
      // "null" and malformed origins (sandboxed frames, file://) are refused, never thrown.
      let originHost = null;
      try { originHost = new URL(origin).host; } catch {}
      if (originHost !== req.headers.host) return { ok: false, status: 403 };
    }
    return { ok: true };
  }
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
  const query = url.searchParams.get("token");
  const supplied = bearer ?? query ?? cookieValue(req);
  if (!supplied || !tokensEqual(supplied, token)) return { ok: false, status: 401 };
  const setCookie = query && tokensEqual(query, token) ? sessionCookie(token) : undefined;
  return { ok: true, setCookie };
}
