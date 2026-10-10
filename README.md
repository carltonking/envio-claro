# Envío Claro

**Mira cuánto cuesta de verdad mandar dinero, antes de pagar.**

Envío Claro shows immigrant families, in Spanish and out loud, what a remittance *really* costs (the fee, the markup hidden in the exchange rate, and the 1% federal tax on cash-funded transfers) and flags scam red flags before they hand over the money. It works on the web and over a plain phone call, so you don't need a smartphone to use it.

Built at the **Latinos x AI Hackathon NYC** (Oct 10, 2026), Finance track.

## Why
- In Profeco's Aug 29, 2026 comparison for $400 → Mexico, the service with the *lower* fee ($1.99) delivered **324 pesos less** than the one charging $2.99. The difference was hidden in the exchange rate.
- Since Jan 1, 2026, transfers paid in **cash** carry a 1% federal excise tax (IRC §4475). Paying by debit card or bank account avoids it.
- Banxico's *Directo a México* service closes on **Nov 20, 2026**.

## How it works
| Piece | Role |
|---|---|
| **Base44** | The app families use: page, data (Provider, Corridor, Resource, Comparison, Config), the AI Spanish summary (InvokeLLM), hosting, analytics |
| **Daytona** | Hosts the Envío Claro API in a sandbox; every deploy runs the math test suite inside the sandbox first |
| **ElevenLabs** | Reads the summary aloud in Spanish (`/api/speak`) and is the voice of the phone line |
| **VAPI + Twilio** | A Spanish phone line: callers say the amount, country and payment method and hear the real cost (`/api/vapi`) |
| **Twilio** | "Mándamelo por SMS" (`/api/sms`); phone numbers are never stored |
| **Tavily** | Refreshes provider rates and news with sources (admin only) |

The math lives in one place, `server/quote.js`:

```
provider_rate = mid × (1 − markup)      received = amount × provider_rate
hidden_usd    = amount × markup          cash_tax = 1% × amount (cash only)
total_cost    = fee + hidden_usd + cash_tax
```

## Run
```bash
npm test                          # golden + Profeco + seed-data audit
npm start                         # API on :3000 (reads .env)
node scripts/deploy-daytona.mjs   # audit inside Daytona, then deploy and print API_BASE
```

API: `GET /api/rate?currency=MXN` · `GET /api/quote?amount=300&country=Honduras&pay=efectivo` · `POST /api/speak {text}` · `POST /api/sms {to,text}` · `POST /api/vapi` (VAPI tool webhook)

## Data and honesty
Provider fees and markups in `server/data/providers.json` are **sourced examples**: Profeco (Sep–Oct 2026), the World Bank Remittance Prices Worldwide (Q3 2025) and provider sites. Every row carries its source URL and date. The mid-market rate is a daily reference from open.er-api.com. Envío Claro takes **no referral fees** from any provider. Educational information, not financial advice.

## Privacy
No accounts for families. No names, phone numbers or immigration status are stored. Comparisons are logged anonymously (amount, country, payment method).
