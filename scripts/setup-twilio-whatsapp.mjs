// Deploys the WhatsApp "front door" as a Twilio Function (Twilio Serverless).
// Why a Function: it runs on Twilio's network, so it can download voice-memo media that the
// Daytona sandbox can't reach. It forwards text/audio to Daytona /api/whatsapp and replies with TwiML.
// Usage: node scripts/setup-twilio-whatsapp.mjs <API_BASE>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(join(ROOT, "..", ".env"));
const API_BASE = (process.argv[2] || "").replace(/\/$/, "");
if (!API_BASE.startsWith("https://")) throw new Error("usage: node scripts/setup-twilio-whatsapp.mjs https://<daytona-url>");
const { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOK, WHATSAPP_TOKEN } = process.env;
const AUTH = "Basic " + Buffer.from(`${SID}:${TOK}`).toString("base64");
const STATE = join(ROOT, "..", ".twilio-fn.json");
const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};

async function tw(method, url, form) {
  const r = await fetch(url, { method, headers: { Authorization: AUTH, ...(form && !(form instanceof FormData) ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, body: form instanceof FormData ? form : form && new URLSearchParams(form) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}
const S = "https://serverless.twilio.com/v1/Services";

const FUNCTION_CODE = `// Envío Claro — WhatsApp front door (Twilio Function). Text or voice memo in, text reply out.
exports.handler = async function (context, event, callback) {
  const twiml = new Twilio.twiml.MessagingResponse();
  try {
    const body = { from: event.From || "", text: event.Body || "" };
    const n = Number(event.NumMedia || 0);
    for (let i = 0; i < n; i++) {
      const type = event["MediaContentType" + i] || "";
      if (!type.startsWith("audio/")) continue;
      const media = await fetch(event["MediaUrl" + i], { headers: { Authorization: "Basic " + Buffer.from(context.ACCOUNT_SID + ":" + context.AUTH_TOKEN).toString("base64") } });
      body.audio_b64 = Buffer.from(await media.arrayBuffer()).toString("base64");
      body.audio_type = type;
      break;
    }
    const r = await fetch(context.API_BASE + "/api/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": context.WHATSAPP_TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(9000),
    });
    const j = await r.json();
    twiml.message(j.reply || "Perdón, no pude responder. ¿Me lo manda otra vez?");
  } catch (e) {
    console.error(e.message);
    twiml.message("Perdón, tardé demasiado. ¿Me lo puede mandar otra vez? 🙏");
  }
  callback(null, twiml);
};
`;

// 1) service + environment + function (idempotent via state file)
if (!st.service) {
  const existing = (await tw("GET", `${S}?PageSize=50`)).services.find((s) => s.unique_name === "envio-claro");
  st.service = existing?.sid || (await tw("POST", S, { UniqueName: "envio-claro", FriendlyName: "Envio Claro", IncludeCredentials: "true", UiEditable: "true" })).sid;
}
if (!st.env) {
  const envs = (await tw("GET", `${S}/${st.service}/Environments`)).environments;
  const e = envs[0] || (await tw("POST", `${S}/${st.service}/Environments`, { UniqueName: "production", DomainSuffix: "prod" }));
  st.env = e.sid; st.domain = e.domain_name;
}
if (!st.fn) st.fn = (await tw("POST", `${S}/${st.service}/Functions`, { FriendlyName: "whatsapp" })).sid;
writeFileSync(STATE, JSON.stringify(st, null, 2));

// 2) upload code
const fd = new FormData();
fd.append("Path", "/whatsapp");
fd.append("Visibility", "public");
fd.append("Content", new Blob([FUNCTION_CODE], { type: "application/javascript" }), "whatsapp.js");
const ver = await tw("POST", `https://serverless-upload.twilio.com/v1/Services/${st.service}/Functions/${st.fn}/Versions`, fd);

// 3) variables
const vars = (await tw("GET", `${S}/${st.service}/Environments/${st.env}/Variables`)).variables;
for (const [Key, Value] of Object.entries({ API_BASE, WHATSAPP_TOKEN })) {
  const v = vars.find((x) => x.key === Key);
  await tw("POST", v ? `${S}/${st.service}/Environments/${st.env}/Variables/${v.sid}` : `${S}/${st.service}/Environments/${st.env}/Variables`, v ? { Value } : { Key, Value });
}

// 4) build → deploy
let build = await tw("POST", `${S}/${st.service}/Builds`, { FunctionVersions: ver.sid, Runtime: "node22" });
for (let i = 0; i < 60 && !["completed", "failed"].includes(build.status); i++) {
  await new Promise((r) => setTimeout(r, 2000));
  build = await tw("GET", `${S}/${st.service}/Builds/${build.sid}`);
}
if (build.status !== "completed") throw new Error("build " + build.status);
await tw("POST", `${S}/${st.service}/Environments/${st.env}/Deployments`, { BuildSid: build.sid });
const env = await tw("GET", `${S}/${st.service}/Environments/${st.env}`);
st.url = `https://${env.domain_name}/whatsapp`;
writeFileSync(STATE, JSON.stringify(st, null, 2));
console.log("WhatsApp webhook URL:", st.url);
