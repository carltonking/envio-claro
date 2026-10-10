// ElevenLabs Agent (text-only) + ElevenLabs Speech-to-Text, used by the WhatsApp channel.
// One WebSocket per incoming message; chat memory is passed in as the {{historial}} dynamic variable.
const env = (k) => process.env[k] || "";

export async function askAgent(text, historial = "", { timeoutMs = 12_000 } = {}) {
  const agentId = env("ELEVENLABS_AGENT_ID");
  if (!agentId || !env("ELEVENLABS_API_KEY")) throw new Error("agente no configurado");
  const signed = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`, { headers: { "xi-api-key": env("ELEVENLABS_API_KEY") } }).then((r) => r.json());
  if (!signed.signed_url) throw new Error("no signed url: " + JSON.stringify(signed).slice(0, 200));

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(signed.signed_url);
    const replies = [];
    let toolPending = false, idle, done = false;
    const finish = (err) => {
      if (done) return; done = true;
      clearTimeout(idle); clearTimeout(hard);
      try { ws.close(); } catch {}
      if (replies.length) resolve(replies.join("\n").trim()); else reject(err || new Error("sin respuesta del agente"));
    };
    const hard = setTimeout(() => finish(new Error("tiempo agotado")), timeoutMs);
    const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => !toolPending && finish(), 1800); };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "conversation_initiation_client_data", dynamic_variables: { historial: historial || "(nueva conversación)" }, conversation_config_override: { conversation: { text_only: true } } }));
      ws.send(JSON.stringify({ type: "user_message", text }));
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "ping") return ws.send(JSON.stringify({ type: "pong", event_id: m.ping_event?.event_id }));
      if (m.type === "agent_tool_request" || m.type === "client_tool_call") { toolPending = true; clearTimeout(idle); }
      if (m.type === "agent_tool_response") { toolPending = false; }
      if (m.type === "agent_response") {
        const t = m.agent_response_event?.agent_response;
        if (t) replies.splice(0, replies.length, ...(replies.length && toolPending === false && replies.at(-1) === t ? replies : [...replies, t]));
        armIdle();
      }
      if (process.env.DEBUG_AGENT) console.log("ws", m.type);
    };
    ws.onerror = (e) => finish(new Error("ws error " + (e.message || "")));
    ws.onclose = () => finish();
  });
}

export async function transcribe(audioBuf, mime = "audio/ogg") {
  const fd = new FormData();
  fd.append("model_id", "scribe_v1");
  fd.append("language_code", "spa");
  fd.append("file", new Blob([audioBuf], { type: mime }), "memo." + (mime.includes("ogg") ? "ogg" : mime.split("/")[1] || "bin"));
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": env("ELEVENLABS_API_KEY") }, body: fd, signal: AbortSignal.timeout(15_000) });
  const j = await r.json();
  if (!r.ok) throw new Error(`stt ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.text?.trim() || "";
}
