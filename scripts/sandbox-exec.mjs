// Runs a shell command inside the Envío Claro Daytona sandbox. Usage: node scripts/sandbox-exec.mjs "<cmd>"
import { Daytona } from "@daytonaio/sdk";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.loadEnvFile(join(ROOT, ".env"));
const sb = await new Daytona({ apiKey: process.env.DAYTONA_API_KEY }).get(readFileSync(join(ROOT, ".daytona-sandbox"), "utf8").trim());
const r = await sb.process.executeCommand(process.argv[2]);
console.log(r.result);
