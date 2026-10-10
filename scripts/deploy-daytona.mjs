// Deploys the Envío Claro API to a Daytona sandbox:
//   1) creates (or reuses) a public sandbox, 2) uploads the server, tests and secrets,
//   3) runs the math test suite INSIDE the sandbox and aborts if it fails,
//   4) (re)starts the API on port 3000 and prints the public URL.
// Usage: node scripts/deploy-daytona.mjs   (reads ../.env for DAYTONA_API_KEY and service keys)
import { Daytona } from "@daytonaio/sdk";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, "..", ".env");
const STATE = join(ROOT, "..", ".daytona-sandbox");
process.loadEnvFile(ENV_FILE);
if (!process.env.DAYTONA_API_KEY) throw new Error("DAYTONA_API_KEY missing in ../.env");

const SERVER_KEYS = ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "ELEVENLABS_MODEL_ID", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "TAVILY_API_KEY", "ADMIN_TOKEN", "ELEVENLABS_AGENT_ID", "WHATSAPP_TOKEN"];
const serverEnv = SERVER_KEYS.filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`).join("\n") + "\nPORT=3000\n";

const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
let sandbox;
if (existsSync(STATE)) {
  try { sandbox = await daytona.get(readFileSync(STATE, "utf8").trim()); await sandbox.start().catch(() => {}); console.log("reusing sandbox", sandbox.id); }
  catch { sandbox = undefined; }
}
if (!sandbox) {
  sandbox = await daytona.create({ language: "typescript", public: true, autoStopInterval: 0, labels: { app: "envio-claro" } }, { timeout: 180 });
  writeFileSync(STATE, sandbox.id);
  console.log("created sandbox", sandbox.id);
}

// Snapshot today's reference rates from here (the sandbox can't reach the FX API).
const fx = await fetch("https://open.er-api.com/v6/latest/USD").then((r) => r.json());
if (fx.result !== "success") throw new Error("FX snapshot failed");
writeFileSync(join(ROOT, "server/data/rates.json"), JSON.stringify({ time_last_update_utc: fx.time_last_update_utc, rates: Object.fromEntries(["MXN", "GTQ", "HNL", "DOP", "COP"].map((c) => [c, fx.rates[c]])) }, null, 1));
console.log("fx snapshot", fx.time_last_update_utc);

const files = ["package.json", ...["server", "server/data", "test"].flatMap((d) => readdirSync(join(ROOT, d), { withFileTypes: true }).filter((f) => f.isFile()).map((f) => `${d}/${f.name}`))];
for (const f of files) await sandbox.fs.uploadFile(readFileSync(join(ROOT, f)), `envio-claro/${f}`);
await sandbox.fs.uploadFile(Buffer.from(serverEnv), "envio-claro/.env");
console.log(`uploaded ${files.length} files + .env (${SERVER_KEYS.filter((k) => process.env[k]).length} keys)`);

const node = await sandbox.process.executeCommand("node -v");
console.log("sandbox node", node.result.trim());

const t = await sandbox.process.executeCommand("cd envio-claro && node --test test/*.test.js 2>&1 | tail -12");
console.log("— Daytona math audit —\n" + t.result);
if (!/fail 0/.test(t.result)) { console.error("AUDIT FAILED — not deploying"); process.exit(1); }

// Restart detached (setsid) so the server outlives the command; session-scoped processes get reaped.
await sandbox.process.executeCommand("pkill -f '[n]ode server/server.js'; sleep 1; cd envio-claro && (setsid nohup node server/server.js > server.log 2>&1 < /dev/null &); sleep 3; cat server.log");

const { url } = await sandbox.getPreviewLink(3000);
const health = await fetch(`${url}/health`).then((r) => r.text()).catch((e) => `ERR ${e.message}`);
console.log(`\nAPI_BASE = ${url}\nhealth: ${health}`);
