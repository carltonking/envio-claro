// Envío Claro — the single source of truth for remittance cost math.
// Pure functions only: no network, no clock. Same formulas as the Base44 page.

export const CASH_TAX_RATE = 0.01; // IRC §4475: 1% of the amount transferred, cash/money order/cashier's check only

export const PAY_METHODS = {
  efectivo: { label_es: "Efectivo", cash: true },
  tarjeta: { label_es: "Tarjeta de débito", cash: false },
  cuenta: { label_es: "Cuenta bancaria", cash: false },
};

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * @param {object} p
 * @param {number} p.amount      USD the family wants to send (S)
 * @param {number} p.midRate     mid-market local units per USD (M)
 * @param {string} p.pay         "efectivo" | "tarjeta" | "cuenta"
 * @param {Array}  p.providers   [{name, fee_usd, markup_pct, ...}] for one currency
 */
export function computeQuotes({ amount, midRate, pay, providers }) {
  if (!(amount > 0)) throw new Error("amount must be > 0");
  if (!(midRate > 0)) throw new Error("midRate must be > 0");
  if (!PAY_METHODS[pay]) throw new Error(`unknown pay method: ${pay}`);
  if (!providers?.length) throw new Error("no providers");

  const cashTax = PAY_METHODS[pay].cash ? amount * CASH_TAX_RATE : 0;

  const rows = providers
    .map((p) => {
      const providerRate = midRate * (1 - p.markup_pct);
      const hidden = amount * p.markup_pct;
      const total = p.fee_usd + hidden + cashTax;
      return {
        name: p.name,
        delivery: p.delivery,
        fee_usd: round2(p.fee_usd),
        markup_pct: p.markup_pct,
        provider_rate: Math.round(providerRate * 10000) / 10000,
        hidden_usd: round2(hidden),
        cash_tax_usd: round2(cashTax),
        total_cost_usd: round2(total),
        cost_pct: Math.round((total / amount) * 10000) / 100,
        you_pay_usd: round2(amount + p.fee_usd + cashTax),
        received_local: round2(amount * providerRate),
        source_note: p.source_note,
        source_url: p.source_url,
        last_checked: p.last_checked,
      };
    })
    .sort((a, b) => a.total_cost_usd - b.total_cost_usd);

  const cheapest = rows[0];
  const worst = rows[rows.length - 1];
  const lowestFee = rows.reduce((a, b) => (b.fee_usd < a.fee_usd ? b : a));
  const feeTrap = lowestFee.name !== cheapest.name;

  return {
    amount,
    mid_rate: midRate,
    pay,
    cash_tax_usd: round2(cashTax),
    rows,
    cheapest: cheapest.name,
    fee_trap: feeTrap,
    lowest_fee_provider: lowestFee.name,
    fee_trap_extra_local: feeTrap ? round2(cheapest.received_local - lowestFee.received_local) : 0,
    savings_vs_worst_usd: round2(worst.total_cost_usd - cheapest.total_cost_usd),
    annual_savings_usd: round2((worst.total_cost_usd - cheapest.total_cost_usd) * 12),
  };
}

const fmtUsd = (x) => `${x.toFixed(2)} dólares`;
const fmtLocal = (x, cur) => `${Math.round(x).toLocaleString("en-US")} ${CURRENCY_NAMES_ES[cur] ?? cur}`;
export const CURRENCY_NAMES_ES = { MXN: "pesos mexicanos", GTQ: "quetzales", HNL: "lempiras", DOP: "pesos dominicanos", COP: "pesos colombianos", "USD-EC": "dólares", "USD-SV": "dólares" };

/** Deterministic Spanish summary — used by the phone line, SMS and as the LLM fallback. */
export function summaryEs(q, corridor) {
  const c = q.rows[0];
  const parts = [
    `Para mandar ${q.amount} dólares a ${corridor.country_es}, la opción más barata es ${c.name}: su familia recibe ${fmtLocal(c.received_local, corridor.currency)}.`,
    `En total le cuesta ${fmtUsd(c.total_cost_usd)}: ${fmtUsd(c.fee_usd)} de comisión y ${fmtUsd(c.hidden_usd)} escondidos en el tipo de cambio${q.cash_tax_usd ? `, más ${fmtUsd(q.cash_tax_usd)} de impuesto por pagar en efectivo` : ""}.`,
  ];
  if (q.fee_trap)
    parts.push(`Ojo: ${q.lowest_fee_provider} cobra la comisión más baja, pero con ${c.name} su familia recibe ${fmtLocal(q.fee_trap_extra_local, corridor.currency)} más.`);
  if (q.cash_tax_usd) parts.push(`Si paga con tarjeta de débito o cuenta del banco, no paga ese impuesto.`);
  if (corridor.alert_es) parts.push(corridor.alert_es);
  return parts.join(" ");
}
