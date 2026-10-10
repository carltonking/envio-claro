# Base44 prompt: FULL APP in one message (Free plan: 5 messages/day, no code edits)

> Paste everything between the lines as ONE message. If something breaks, don't send "fix it"; send Claude the error or a screenshot, and we'll write one precise fix message together.
> Afterwards, import the data via **Dashboard → Data** (free, no credits): see the bottom of this file.

---

Build a single-page, mobile-first, **Spanish-language** web app called **"Envío Claro"**. It helps immigrant families in the US see the TRUE cost of sending money home (fee + hidden exchange-rate markup + a 1% federal tax when paying cash) before they choose a provider. Families never log in. Never store names, phone numbers or immigration status.

## Data entities (create exactly these, with these field names)
1. **Corridor**: country_es (text), currency (text), flag (text), fallback_mid_rate (number), alert_es (text), active (boolean)
2. **Provider**: name (text), currency (text), fee_usd (number), markup_pct (number; a fraction, e.g. 0.0190 means 1.90%), delivery (text), source_note (text), source_url (text), last_checked (text)
3. **Resource**: name_es (text), phone (text), url (text), kind (text)
4. **Comparison**: amount_usd (number), currency (text), pay_method (text), cheapest_provider (text), fee_trap (boolean), cash_tax_usd (number), scam_flag (boolean)
5. **Config**: key (text), value (text). The app reads the row with key = "api_base" and uses its value as API_BASE (an external URL like https://xxxx.proxy.daytona.works). If it's missing or empty, the features that need it hide gracefully.

Seed **Corridor** with 4 rows:
- México, MXN, 🇲🇽, 18.33, alert_es "Directo a México (Banxico) deja de operar el 20 de noviembre de 2026."
- Guatemala, GTQ, 🇬🇹, 7.63, ""
- Honduras, HNL, 🇭🇳, 26.81, ""
- República Dominicana, DOP, 🇩🇴, 60.52, ""
(all active = true). Seed **Config** with one row: key "api_base", value "". Leave Provider and Resource empty; I will import them.

## Page "Enviar" (the only page), top to bottom
1. **Header:** "Envío Claro". Subtitle: "Mira cuánto cuesta de verdad mandar dinero, antes de pagar."
2. **Form:**
   - "¿Cuánto vas a mandar? (USD)": number input, default 300
   - "¿A qué país?": dropdown of active Corridor rows (flag + country_es)
   - "¿Cómo vas a pagar?": 3 large toggle buttons: "Efectivo" / "Tarjeta de débito" / "Cuenta bancaria" (default Tarjeta de débito)
   - "¿Alguien te pidió este envío por teléfono o WhatsApp (ICE, abogado, fianza, premio)?": Sí / No (default No)
   - Big primary button: **"Ver costo real"**
3. **On click:**
   a. Get the mid-market rate M: `GET {API_BASE}/api/rate?currency=XXX` returns JSON `{rate, updated, source, approx}`. If API_BASE is empty or the call fails, use the corridor's fallback_mid_rate and set approx = true.
   b. For each Provider with that currency (S = amount, F = fee_usd, m = markup_pct):
      provider_rate = M × (1 − m); received = S × provider_rate; hidden_usd = S × m;
      cash_tax_usd = (pay = Efectivo) ? 0.01 × S : 0; total_cost_usd = F + hidden_usd + cash_tax_usd
   c. Sort ascending by total_cost_usd.
   d. fee_trap = (the provider with the lowest fee_usd) is NOT the provider with the lowest total_cost_usd.
   e. Create one Comparison record with these values (anonymous).
4. **Results:**
   - **Table** with columns: Servicio · Comisión · Tipo de cambio · Costo escondido · Impuesto 1% · Costo total · Tu familia recibe. First row green with a "Más barato" badge. On phones, render each provider as a card instead of a wide table.
   - Big line under it: "Con **{cheapest}** tu familia recibe **{received} {currency}**. Pagas **${total_cost}** en costos: ${fee} de comisión + ${hidden} escondidos en el tipo de cambio{+ $tax de impuesto}."
   - **Alert cards** (show only those that apply):
     - 🟥 "Trampa de comisión" (if fee_trap): "{lowest-fee provider} cobra la comisión más baja, pero con {cheapest} tu familia recibe {difference in local currency} {currency} más."
     - 🟧 "Impuesto de 1% por pagar en efectivo" (if Efectivo): "Pagando en efectivo pagas ${tax} de impuesto federal. Con tarjeta de débito o cuenta bancaria no se cobra."
     - 🟦 "Aviso" (if the corridor's alert_es is not empty): show alert_es.
     - ⚠️ red "Cuidado: puede ser una estafa" (if the scam answer = Sí): "No mandes dinero todavía. Nadie de ICE ni de la corte cobra fianzas por teléfono o WhatsApp." Then list every Resource with kind = "estafa" (name_es, phone as a tel: link, url).
   - **"Resumen"** card: use the built-in LLM integration to write a summary of at most 3 short sentences in simple, warm Spanish (use "usted"). Give it ONLY the computed numbers as JSON (cheapest, received, currency, total_cost, hidden, tax, fee_trap, the alert texts) and instruct: "Usa solo estos números, no inventes ninguno." If the LLM fails, show the big line above instead.
   - **🔊 "Escuchar"** button: `POST {API_BASE}/api/speak` with JSON `{text}` (the summary text). The response is audio/mpeg; play it. Show "Cargando voz…" while it waits. Hide the button if API_BASE is empty.
   - **📱 "Mándamelo por SMS"**: a phone input + "Enviar" → `POST {API_BASE}/api/sms` with JSON `{to, text}`. Show "¡Enviado!" or the error. Do NOT save the phone number anywhere. Hide if API_BASE is empty.
5. **"¿No tienes internet? Llámanos"** card: shows the phone number from the Config row with key "phone" (hidden if missing): "Llama gratis y pregunta en español: {phone}".
6. **Footer:** "Tasa de referencia: {source}, actualizada {updated}" (add "(aproximada)" if approx) · a small "Fuentes" list: each provider's name, source_note, last_checked, and source_url as a link · a counter: "{number of Comparison records} comparaciones hechas" · disclaimer: "Información educativa, no asesoría financiera. Tarifas de ejemplo: confirma con el proveedor antes de enviar. No guardamos tus datos personales."

## Design
Mobile-first (perfect at 375px wide), body text ≥ 18px, large tap targets, high contrast. Colors: deep green #0B6E4F primary, amber #F59E0B warnings, red #DC2626 scam alerts, off-white background. Simple, warm Spanish everywhere. Money as $1,234.56; local currency as "5,292.00 MXN". Loading states on every async action.

---

## After it builds (Carlton, no credits needed)
1. **Dashboard → Data → Provider → Import** `seed/providers.csv` (16 rows). **Resource → Import** `seed/resources.csv` (4 rows). If import isn't available, add the rows by hand (Claude can help).
2. **Config:** set `api_base` once Claude sends the Daytona URL, and add a row `phone` = the VAPI number later.
3. **Publish** → send Claude the public URL + a screenshot.
4. In **Code** view (read-only on Free), send Claude the page file contents so it can go in the GitHub repo.
