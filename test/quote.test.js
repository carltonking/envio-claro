import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeQuotes, summaryEs } from "../server/quote.js";

const providers = JSON.parse(readFileSync(new URL("../server/data/providers.json", import.meta.url)));
const corridors = JSON.parse(readFileSync(new URL("../server/data/corridors.json", import.meta.url)));

const golden = [{ name: "Golden", fee_usd: 5, markup_pct: 0.02 }];

test("golden case, card: S=300 M=18 F=5 m=2%", () => {
  const q = computeQuotes({ amount: 300, midRate: 18, pay: "tarjeta", providers: golden });
  const r = q.rows[0];
  assert.equal(r.provider_rate, 17.64);
  assert.equal(r.received_local, 5292);
  assert.equal(r.hidden_usd, 6);
  assert.equal(r.cash_tax_usd, 0);
  assert.equal(r.total_cost_usd, 11);
  assert.equal(r.cost_pct, 3.67);
  assert.equal(r.you_pay_usd, 305);
});

test("golden case, cash adds the 1% tax on the amount sent (not the fee)", () => {
  const r = computeQuotes({ amount: 300, midRate: 18, pay: "efectivo", providers: golden }).rows[0];
  assert.equal(r.cash_tax_usd, 3);
  assert.equal(r.total_cost_usd, 14);
  assert.equal(r.you_pay_usd, 308);
  assert.equal(r.received_local, 5292); // tax doesn't change what the family receives
});

test("Profeco 29-ago-2026 reality check: the lower fee delivered 324 pesos less", () => {
  // Profeco published rates directly; express them as markup vs a common reference rate.
  const M = 18;
  const q = computeQuotes({
    amount: 400, midRate: M, pay: "cuenta",
    providers: [
      { name: "Finabien", fee_usd: 2.99, markup_pct: 1 - 17.38 / M },
      { name: "WorldRemit", fee_usd: 1.99, markup_pct: 1 - 16.57 / M },
    ],
  });
  const fin = q.rows.find((r) => r.name === "Finabien");
  const wr = q.rows.find((r) => r.name === "WorldRemit");
  assert.equal(fin.received_local, 6952);
  assert.equal(wr.received_local, 6628);
  assert.equal(q.cheapest, "Finabien");
  assert.equal(q.fee_trap, true);
  assert.equal(q.fee_trap_extra_local, 324);
});

test("rows are sorted by total cost and the fee trap fires on the MX seed at $300", () => {
  const q = computeQuotes({ amount: 300, midRate: 18.33, pay: "tarjeta", providers: providers.filter((p) => p.currency === "MXN") });
  for (let i = 1; i < q.rows.length; i++) assert.ok(q.rows[i - 1].total_cost_usd <= q.rows[i].total_cost_usd);
  assert.equal(q.fee_trap, true);
});

test("seed data audit: 4 providers per corridor, sane ranges, real sources", () => {
  for (const c of corridors) {
    const ps = providers.filter((p) => p.currency === c.currency);
    assert.equal(ps.length, 4, `${c.currency} should have 4 providers`);
    for (const p of ps) {
      assert.ok(p.markup_pct >= 0 && p.markup_pct <= 0.1, `${p.name}/${c.currency} markup_pct must be a fraction 0–0.10, got ${p.markup_pct}`);
      assert.ok(p.fee_usd >= 0 && p.fee_usd <= 15, `${p.name}/${c.currency} fee out of range`);
      assert.match(p.source_url, /^https:\/\//, `${p.name}/${c.currency} needs a source URL`);
    }
    const q = computeQuotes({ amount: 300, midRate: c.fallback_mid_rate, pay: "efectivo", providers: ps });
    assert.ok(q.rows.every((r) => r.received_local > 0));
  }
});

test("Spanish summary uses only computed numbers and mentions tax + alerts", () => {
  const mx = corridors.find((c) => c.currency === "MXN");
  const q = computeQuotes({ amount: 300, midRate: 18.33, pay: "efectivo", providers: providers.filter((p) => p.currency === "MXN") });
  const s = summaryEs(q, mx);
  assert.match(s, /impuesto/);
  assert.match(s, /Directo a México/);
  assert.match(s, new RegExp(q.cheapest));
});

test("dollarized corridors have no hidden FX cost; family receives exactly the amount", () => {
  for (const cur of ["USD-EC", "USD-SV"]) {
    const q = computeQuotes({ amount: 300, midRate: 1, pay: "efectivo", providers: providers.filter((p) => p.currency === cur) });
    assert.ok(q.rows.every((r) => r.hidden_usd === 0 && r.received_local === 300));
    assert.equal(q.rows[0].total_cost_usd, q.rows[0].fee_usd + 3);
  }
});

test("Colombia: zero-fee Xoom is a fee trap at $300", () => {
  const q = computeQuotes({ amount: 300, midRate: 3236.57, pay: "cuenta", providers: providers.filter((p) => p.currency === "COP") });
  assert.equal(q.lowest_fee_provider, "Xoom (PayPal)");
  assert.equal(q.fee_trap, true);
});

test("rejects bad input", () => {
  assert.throws(() => computeQuotes({ amount: 0, midRate: 18, pay: "tarjeta", providers: golden }));
  assert.throws(() => computeQuotes({ amount: 100, midRate: 18, pay: "bitcoin", providers: golden }));
});
