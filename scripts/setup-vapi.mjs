// Creates (or updates) the "Envío Claro" VAPI phone assistant and attaches a phone number.
//   - Voice: ElevenLabs (multilingual), Transcriber: Deepgram Spanish, Model: fast LLM
//   - Tool: cotizar_envio → POST {API_BASE}/api/vapi (the Daytona API). The model never does math.
// Usage: node scripts/setup-vapi.mjs <API_BASE>
// Env (../.env): VAPI_API_KEY, ELEVENLABS_VOICE_ID (optional), TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_PHONE_NUMBER (optional: import the number)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(join(ROOT, "..", ".env"));
const API_BASE = (process.argv[2] || "").replace(/\/$/, "");
if (!API_BASE.startsWith("https://")) throw new Error("usage: node scripts/setup-vapi.mjs https://<daytona-url>");
const KEY = process.env.VAPI_API_KEY;
if (!KEY) throw new Error("VAPI_API_KEY missing in ../.env");
const STATE = join(ROOT, "..", ".vapi-state.json");
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};

const vapi = async (method, path, body) => {
  const r = await fetch(`https://api.vapi.ai${path}`, { method, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j).slice(0, 400)}`);
  return j;
};

const SYSTEM = `Eres "Envío Claro", una línea telefónica en español que ayuda a familias inmigrantes en Estados Unidos a saber cuánto cuesta DE VERDAD mandar dinero a México, Guatemala, Honduras, República Dominicana, El Salvador, Ecuador o Colombia. En El Salvador y Ecuador se usa el dólar: no hay costo escondido en el tipo de cambio, solo comisión e impuesto si paga en efectivo.
Reglas:
1. Habla en español sencillo, cálido y respetuoso (usa "usted"). Frases cortas. Nada de jerga financiera.
2. Necesitas tres datos: cuánto quiere mandar en dólares, a qué país, y cómo va a pagar (efectivo, tarjeta de débito o cuenta del banco). Pregunta solo lo que falte, uno a la vez.
3. Cuando tengas los tres, di "Un momento, lo calculo" y llama a la herramienta cotizar_envio. NUNCA calcules ni inventes números: solo repite los que te da la herramienta, redondeados.
4. Responde en este orden: (a) el servicio más barato y cuánto recibe la familia; (b) cuánto le cuesta en total, incluyendo lo escondido en el tipo de cambio; (c) si paga en efectivo, que hay un impuesto de 1% y que con tarjeta de débito o cuenta del banco se lo ahorra; (d) si hay trampa_comision, explique que la comisión más baja no es la más barata; (e) el aviso del país si hay uno.
5. Si la persona menciona que alguien le pidió el dinero por teléfono, WhatsApp, "ICE", "fianza", "abogado" o "premio": con calma, dígale que puede ser una estafa, que no mande nada todavía, y que puede llamar al 311 en Nueva York o a la Oficina para Nuevos Americanos al 1-800-566-7636. No dé otros números.
6. No pidas nombre, dirección, número de cuenta ni estatus migratorio. NUNCA afirmes lo que una empresa o el gobierno hace con los datos de las personas; si preguntan, explique que las empresas deben cumplir las leyes de EE. UU. y que, para su caso, hable gratis con un abogado de inmigración o con la Oficina para Nuevos Americanos al 1-800-566-7636. Responda en el idioma de la persona (español por defecto).
7. Aclara una vez: "Es información educativa; confirme la tarifa con el servicio antes de enviar."
8. Al final pregunta si quiere comparar otro envío. Si no, despídete con calidez.`;

const assistant = {
  name: "Envío Claro",
  firstMessage: "Hola, gracias por llamar a Envío Claro. Le ayudo a ver cuánto cuesta de verdad mandar dinero. ¿Cuánto quiere mandar y a qué país?",
  transcriber: { provider: "deepgram", model: "nova-2", language: "es" },
  voice: { provider: "11labs", voiceId: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM", model: "eleven_multilingual_v2" },
  model: {
    provider: "openai", model: "gpt-4o-mini", temperature: 0.3,
    messages: [{ role: "system", content: SYSTEM }],
    tools: [{
      type: "function",
      function: {
        name: "cotizar_envio",
        description: "Calcula el costo real de mandar dinero (comisión, costo escondido en el tipo de cambio, impuesto de 1% por efectivo) y el proveedor más barato.",
        parameters: {
          type: "object",
          properties: {
            monto_usd: { type: "number", description: "Dólares a mandar" },
            pais: { type: "string", enum: ["México", "Guatemala", "Honduras", "República Dominicana", "El Salvador", "Ecuador", "Colombia"] },
            pago: { type: "string", enum: ["efectivo", "tarjeta", "cuenta"] },
          },
          required: ["monto_usd", "pais", "pago"],
        },
      },
      server: { url: `${API_BASE}/api/vapi` },
      messages: [{ type: "request-start", content: "Un momento, lo calculo." }],
    }],
  },
  maxDurationSeconds: 240,
  endCallPhrases: ["adiós", "hasta luego"],
};

const a = state.assistantId ? await vapi("PATCH", `/assistant/${state.assistantId}`, assistant) : await vapi("POST", "/assistant", assistant);
state.assistantId = a.id;
console.log("assistant", a.id);

if (!state.phoneNumberId && process.env.TWILIO_PHONE_NUMBER && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_ACCOUNT_SID?.startsWith("AC")) {
  const p = await vapi("POST", "/phone-number", {
    provider: "twilio", number: process.env.TWILIO_PHONE_NUMBER,
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID, twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
    assistantId: a.id, name: "Envío Claro",
  });
  state.phoneNumberId = p.id; state.number = p.number;
  console.log("phone number imported", p.number);
} else if (state.phoneNumberId) {
  await vapi("PATCH", `/phone-number/${state.phoneNumberId}`, { assistantId: a.id });
}
writeFileSync(STATE, JSON.stringify(state, null, 2));
console.log(`\nDone. Call: ${state.number || "(no phone number yet: add TWILIO_* to .env, or buy a VAPI number in the dashboard and attach the assistant)"}\nWeb test: dashboard.vapi.ai → Assistants → Envío Claro → Talk`);
