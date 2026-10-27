/* Minimal HTTP toolkit: router with :params, JSON bodies with size limits, errors, CORS, rate limits. */
export class HttpError extends Error {
  constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra; }
}
export const bad = (code, message, extra) => new HttpError(400, code, message, extra);

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
    this.routes.push({ method, re, keys, handler, opts });
  }
  get(p, h, o) { this.add("GET", p, h, o); }
  post(p, h, o) { this.add("POST", p, h, o); }
  patch(p, h, o) { this.add("PATCH", p, h, o); }
  del(p, h, o) { this.add("DELETE", p, h, o); }
  match(method, path) {
    let allowed = false;
    for (const r of this.routes) {
      const m = path.match(r.re); if (!m) continue;
      if (r.method !== method) { allowed = true; continue; }
      const params = {}; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return allowed ? "method" : null;
  }
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers["content-length"] || 0);
    if (len > limit) { req.resume(); return reject(new HttpError(413, "too_large", "Request body is too large")); }
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > limit) { reject(new HttpError(413, "too_large", "Request body is too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
export async function readJson(req, limit = 256 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { const v = JSON.parse(buf.toString("utf8")); if (v && typeof v === "object") return v; } catch {}
  throw bad("bad_json", "Body must be a JSON object");
}

export function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

export function cors(req, res, origins) {
  const o = req.headers.origin;
  if (o && (origins.includes("*") || origins.includes(o))) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

/* Fixed-window counters kept in memory: enough for one server process. */
export class Limiter {
  constructor() { this.m = new Map(); setInterval(() => { const t = Date.now(); for (const [k, v] of this.m) if (v.reset < t) this.m.delete(k); }, 60_000).unref(); }
  hit(key, max, windowMs) {
    const t = Date.now(); let v = this.m.get(key);
    if (!v || v.reset < t) { v = { n: 0, reset: t + windowMs }; this.m.set(key, v); }
    v.n++;
    if (v.n > max) throw new HttpError(429, "rate_limited", "Too many requests, try again later", { retry_in: Math.ceil((v.reset - t) / 1000) });
    return max - v.n;
  }
}

/* X-Forwarded-For is trusted only behind our own proxy (TRUST_PROXY=1), otherwise anyone could fake it to dodge rate limits */
export const clientIp = req => (process.env.TRUST_PROXY === "1" && String(req.headers["x-forwarded-for"] || "").split(",").pop().trim()) || req.socket.remoteAddress || "?";
export const int = (v, min, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
export const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
