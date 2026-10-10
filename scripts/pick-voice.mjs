// Lists Spanish-capable ElevenLabs voices so we can pick a warm Latin-American one.
// Usage: node scripts/pick-voice.mjs
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env"));
const r = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } });
const { voices = [] } = await r.json();
const es = voices.filter((v) => /spanish|latin|mexic|es-/i.test(JSON.stringify([v.labels, v.verified_languages, v.name, v.description])));
for (const v of (es.length ? es : voices).slice(0, 25)) console.log(v.voice_id, "|", v.name, "|", JSON.stringify(v.labels || {}), "|", (v.verified_languages || []).map((l) => l.accent || l.language).join(","));
