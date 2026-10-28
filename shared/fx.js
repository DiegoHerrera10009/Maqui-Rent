export const FX = {
  asOf: "2026-10-28",
  note: "Equivalente de referencia del 28 de octubre de 2026 (TRM Colombia 3.148,02; euro 1,1133 dólares; real derivado). No es la tasa con la que cobra el procesador.",
  perUsd: {
    USD: 1,
    COP: 3148.02,
    EUR: 0.89823,
    BRL: 5.356,
  },
};

export function usdToMinor(usd, currency, minorUnit) {
  const perUsd = FX.perUsd[currency];
  if (!perUsd) throw new Error(`Sin tasa de referencia para ${currency}.`);
  return Math.round(usd * perUsd * minorUnit);
}
