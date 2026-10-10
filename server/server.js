// Envío Claro API — runs in a Daytona sandbox; called by the Base44 page, the VAPI phone line and Twilio.
// Zero dependencies (Node >= 20). Secrets come from environment variables only.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { computeQuotes, summaryEs } from "./quote.js";

const load = (f) => JSON.parse(readFileSync(new URL(`./data/${f}`, import.meta.url)));
const PROVIDERS = load("providers.json");
const CORRIDORS = load("corridors.json");
const RESOURCES = load("resources.json");

try { process.loadEnvFile?.(new URL("../.env", import.meta.url)); } catch {} // secrets live in .env (never committed)
const PORT = Number(process.env.PORT || 3000);
const env = (k) => process.env[k] || "";

// ---------- helpers ----------
// The Daytona preview proxy already echoes Access-Control-Allow-Origin; sending our own too
// produces a duplicate header that browsers reject. Set CORS_ORIGIN=* only when running elsewhere.
const CORS = {
  ...(process.env.CORS_ORIGIN ? { "Access-Control-Allow-Origin": process.env.CORS_ORIGIN } : {}),
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Admin-Token",
};
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, { ...CORS, "Content-Type": isBuf ? "audio/mpeg" : "application/json; charset=utf-8", ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
}
async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function findCorridor(input) {
  const n = norm(input);
  return CORRIDORS.find((c) => [c.currency, c.country_es].map(norm).includes(n))
    || CORRIDORS.find((c) => n.includes(norm(c.country_es)) || (n.includes("dominicana") && c.currency === "DOP") || (n.includes("mexico") && c.currency === "MXN"));
}
function normPay(input) {
  const n = norm(input);
  if (/efect|cash|money ?order|giro|cheque/.test(n)) return "efectivo";
  if (/cuenta|banco|bank|transfer/.test(n)) return "cuenta";
  return "tarjeta"; // tarjeta / débito / crédito / default
}

// ---------- mid-market rate (open.er-api.com, cached) ----------
// Daytona's free tier blocks most outbound hosts, so the deploy script uploads a daily snapshot
// (data/rates.json, fetched from open.er-api.com). Live fetch is only tried if the snapshot is stale.
let fxCache = { at: 0, data: null };
function snapshotRate(currency) {
  try {
    const snap = JSON.parse(readFileSync(new URL("./data/rates.json", import.meta.url)));
    const ageH = (Date.now() - Date.parse(snap.time_last_update_utc)) / 3_600_000;
    if (snap.rates?.[currency] && ageH < 48) return { rate: snap.rates[currency], updated: snap.time_last_update_utc, source: "open.er-api.com (tasa de referencia diaria)", approx: false };
  } catch {}
  return null;
}
async function midRate(currency) {
  const corridor = CORRIDORS.find((c) => c.currency === currency);
  const snap = snapshotRate(currency);
  if (snap) return snap;
  try {
    if (!fxCache.data || Date.now() - fxCache.at > 30 * 60_000) {
      const r = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      if (j.result !== "success") throw new Error("fx api error");
      fxCache = { at: Date.now(), data: j };
    }
    const rate = fxCache.data.rates[currency];
    if (!rate) throw new Error(`no rate for ${currency}`);
    return { rate, updated: fxCache.data.time_last_update_utc, source: "open.er-api.com (tasa de referencia diaria)", approx: false };
  } catch {
    return { rate: corridor.fallback_mid_rate, updated: "respaldo", source: "tasa de respaldo", approx: true };
  }
}

async function quote({ amount, country, pay }) {
  const corridor = findCorridor(country);
  if (!corridor) throw Object.assign(new Error("país no soportado: usa México, Guatemala, Honduras o República Dominicana"), { status: 400 });
  const amt = Number(amount);
  if (!(amt > 0 && amt <= 10_000)) throw Object.assign(new Error("monto debe ser entre 1 y 10,000 dólares"), { status: 400 });
  const fx = await midRate(corridor.currency);
  const q = computeQuotes({ amount: amt, midRate: fx.rate, pay: normPay(pay), providers: PROVIDERS.filter((p) => p.currency === corridor.currency) });
  return { ...q, currency: corridor.currency, country_es: corridor.country_es, fx, alert_es: corridor.alert_es, summary_es: summaryEs(q, corridor) };
}

// ---------- ElevenLabs TTS (cached by text) ----------
const ttsCache = new Map();
async function speak(text) {
  if (!env("ELEVENLABS_API_KEY")) throw Object.assign(new Error("voz no configurada"), { status: 503 });
  const clean = String(text || "").slice(0, 800);
  if (!clean) throw Object.assign(new Error("text requerido"), { status: 400 });
  const key = createHash("sha1").update(clean).digest("hex");
  if (ttsCache.has(key)) return ttsCache.get(key);
  const voice = env("ELEVENLABS_VOICE_ID") || "21m00Tcm4TlvDq8ikWAM";
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": env("ELEVENLABS_API_KEY"), "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text: clean, model_id: env("ELEVENLABS_MODEL_ID") || "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.8 } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw Object.assign(new Error(`elevenlabs ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: 502 });
  const buf = Buffer.from(await r.arrayBuffer());
  if (ttsCache.size > 200) ttsCache.clear();
  ttsCache.set(key, buf);
  return buf;
}

// ---------- Twilio SMS (number is never stored or logged) ----------
const smsWindow = [];
async function sms(to, text) {
  const sid = env("TWILIO_ACCOUNT_SID"), tok = env("TWILIO_AUTH_TOKEN"), from = env("TWILIO_PHONE_NUMBER");
  if (!sid || !tok || !from) throw Object.assign(new Error("SMS no configurado"), { status: 503 });
  let num = String(to || "").replace(/[^\d+]/g, "");
  if (/^\d{10}$/.test(num)) num = "+1" + num;
  if (!/^\+\d{10,15}$/.test(num)) throw Object.assign(new Error("número inválido"), { status: 400 });
  const now = Date.now();
  while (smsWindow.length && now - smsWindow[0] > 3_600_000) smsWindow.shift();
  if (smsWindow.length >= 30) throw Object.assign(new Error("límite de SMS alcanzado, intenta más tarde"), { status: 429 });
  smsWindow.push(now);
  const body = `Envío Claro: ${String(text || "").slice(0, 600)}`;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: num, From: from, Body: body }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`twilio: ${j.message || r.status}`), { status: 502 });
  return { ok: true };
}

// ---------- VAPI tool webhook ----------
async function vapiTool(body) {
  const calls = body?.message?.toolCallList || body?.message?.toolWithToolCallList?.map((t) => t.toolCall) || [];
  const results = [];
  for (const call of calls) {
    let args = call.function?.arguments ?? call.arguments ?? {};
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
    let result;
    try {
      const q = await quote({ amount: args.monto_usd ?? args.amount, country: args.pais ?? args.country, pay: args.pago ?? args.pay });
      const c = q.rows[0];
      result = JSON.stringify({
        mejor: c.name, recibe_local: Math.round(c.received_local), moneda: q.currency,
        costo_total_usd: c.total_cost_usd, escondido_usd: c.hidden_usd, comision_usd: c.fee_usd,
        impuesto_efectivo_usd: q.cash_tax_usd, trampa_comision: q.fee_trap ? q.lowest_fee_provider : null,
        aviso_pais: q.alert_es || null, tasa_aproximada: q.fx.approx, frase: q.summary_es,
      });
    } catch (e) {
      result = JSON.stringify({ error: e.message });
    }
    results.push({ toolCallId: call.id, result });
  }
  return { results };
}

// ---------- router ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (url.pathname === "/" || url.pathname === "/health")
      return send(res, 200, { ok: true, service: "envio-claro-api", corridors: CORRIDORS.map((c) => c.currency), voice: !!env("ELEVENLABS_API_KEY"), sms: !!env("TWILIO_AUTH_TOKEN") });
    if (url.pathname === "/api/rate" && req.method === "GET") {
      const cur = String(url.searchParams.get("currency") || "").toUpperCase();
      if (!CORRIDORS.some((c) => c.currency === cur)) return send(res, 400, { error: "currency must be MXN, GTQ, HNL or DOP" });
      return send(res, 200, await midRate(cur));
    }
    if (url.pathname === "/api/quote" && req.method === "GET")
      return send(res, 200, await quote({ amount: url.searchParams.get("amount"), country: url.searchParams.get("country"), pay: url.searchParams.get("pay") }));
    if (url.pathname === "/api/providers" && req.method === "GET") return send(res, 200, PROVIDERS);
    if (url.pathname === "/api/resources" && req.method === "GET") return send(res, 200, RESOURCES);
    if (url.pathname === "/api/speak" && req.method === "POST") return send(res, 200, await speak((await readJson(req)).text));
    if (url.pathname === "/api/sms" && req.method === "POST") { const b = await readJson(req); return send(res, 200, await sms(b.to, b.text)); }
    if (url.pathname === "/api/vapi" && req.method === "POST") return send(res, 200, await vapiTool(await readJson(req)));
    return send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(req.method, url.pathname, e.message); // never logs bodies (phone numbers)
    return send(res, e.status || 500, { error: e.message });
  }
});
server.listen(PORT, () => console.log(`envio-claro-api listening on :${PORT}`));
