import { country } from "./countries.js";
import { daysBetween } from "./ids.js";

export const FEE = {
  ownerCommissionRate: 0.08,
  serviceFeeRate: 0.05,
  protectionRate: 0.04,
  protectionPlatformShare: 0.25,
  depositRate: 0.2,
};

export function quoteRental({ cell, dailyRate, startDate, endDate, freight = 0, logistics = null }) {
  const info = country(cell);
  const days = daysBetween(startDate, endDate);
  const rental = dailyRate * days;
  const ownerCommission = Math.round(rental * FEE.ownerCommissionRate);
  const serviceFee = Math.round(rental * FEE.serviceFeeRate);
  const protection = Math.round(rental * FEE.protectionRate);
  const protectionPlatform = Math.round(protection * FEE.protectionPlatformShare);
  const protectionInsurer = protection - protectionPlatform;
  const transport = Math.max(0, Math.round(freight));
  const commercial = rental + serviceFee + protection;
  const charged = commercial + transport;
  const processorFee = Math.round(commercial * info.processorFeeRate);
  const ownerPayout = rental - ownerCommission;
  const platformGross = ownerCommission + serviceFee + protectionPlatform;
  const platformNet = platformGross - processorFee;
  const deposit = Math.round(rental * FEE.depositRate);
  const quote = {
    cell,
    currency: info.currency,
    provider: info.provider,
    processorFeeRate: info.processorFeeRate,
    days,
    dailyRate,
    rental,
    ownerCommission,
    serviceFee,
    protection,
    protectionPlatform,
    protectionInsurer,
    transport,
    logistics,
    charged,
    processorFee,
    ownerPayout,
    platformGross,
    platformNet,
    deposit,
    marginOnRental: rental === 0 ? 0 : platformNet / rental,
  };
  assertSplit(quote);
  return quote;
}

export function assertSplit(quote) {
  const legs = quote.ownerPayout + quote.platformNet + quote.protectionInsurer + quote.processorFee + (quote.transport || 0);
  if (legs !== quote.charged) {
    throw new Error(`El split no cierra: ${legs} contra ${quote.charged}.`);
  }
}

function planBase(captured, refund, legs, extra = {}) {
  const sum = legs.ownerPayout + legs.platformNet + (legs.insurer || 0) + legs.processorFee + (legs.carrier || 0);
  if (sum !== captured) {
    throw new Error(`La captura no cierra: ${sum} contra ${captured}.`);
  }
  return { captured, refund, ...legs, ...extra };
}

export function settlementPlan(quote, outcome) {
  const rate = quote.processorFeeRate;
  if (outcome === "settle" || outcome === "dispute_release") {
    return planBase(quote.charged, 0, {
      ownerPayout: quote.ownerPayout,
      platformGross: quote.platformGross,
      platformNet: quote.platformNet,
      insurer: quote.protectionInsurer,
      processorFee: quote.processorFee,
      carrier: quote.transport || 0,
      ownerCommission: quote.ownerCommission,
      serviceFee: quote.serviceFee,
      protectionPlatform: quote.protectionPlatform,
      rentalRecognized: quote.rental,
    });
  }
  if (outcome === "cancel_full" || outcome === "dispute_refund") {
    return planBase(0, quote.charged, {
      ownerPayout: 0,
      platformGross: 0,
      platformNet: 0,
      insurer: 0,
      processorFee: 0,
      carrier: 0,
      ownerCommission: 0,
      serviceFee: 0,
      protectionPlatform: 0,
      rentalRecognized: 0,
    });
  }
  if (outcome === "cancel_partial" || outcome === "dispute_split") {
    const rentalRecognized = Math.round(quote.rental * 0.5);
    const captured = rentalRecognized + quote.serviceFee;
    const ownerCommission = Math.round(rentalRecognized * FEE.ownerCommissionRate);
    const ownerPayout = rentalRecognized - ownerCommission;
    const platformGross = ownerCommission + quote.serviceFee;
    const processorFee = Math.round(captured * rate);
    const platformNet = platformGross - processorFee;
    return planBase(captured, quote.charged - captured, {
      ownerPayout,
      platformGross,
      platformNet,
      insurer: 0,
      processorFee,
      carrier: 0,
      ownerCommission,
      serviceFee: quote.serviceFee,
      protectionPlatform: 0,
      rentalRecognized,
    });
  }
  if (outcome === "cancel_penalty") {
    const captured = quote.rental + quote.serviceFee;
    const platformGross = quote.ownerCommission + quote.serviceFee;
    const processorFee = Math.round(captured * rate);
    const platformNet = platformGross - processorFee;
    return planBase(captured, quote.charged - captured, {
      ownerPayout: quote.ownerPayout,
      platformGross,
      platformNet,
      insurer: 0,
      processorFee,
      carrier: 0,
      ownerCommission: quote.ownerCommission,
      serviceFee: quote.serviceFee,
      protectionPlatform: 0,
      rentalRecognized: quote.rental,
    });
  }
  throw new Error(`Resultado de liquidación desconocido: ${outcome}`);
}

export function cancellationPolicy(startDate, now = new Date()) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const days = (start.getTime() - now.getTime()) / 86400000;
  if (days >= 7) {
    return {
      code: "full",
      outcome: "cancel_full",
      daysAhead: Math.floor(days),
      title: "Reembolso total",
      detail: "Faltan 7 días o más. Se revierte todo el cobro retenido y se libera el depósito. No se emiten facturas.",
    };
  }
  if (days >= 3) {
    return {
      code: "partial",
      outcome: "cancel_partial",
      daysAhead: Math.floor(days),
      title: "Reembolso parcial",
      detail: "Faltan entre 3 y 7 días. Se retiene el 50% del arrendamiento y la tarifa de servicio. Se devuelve el resto, incluida la protección, y se libera el depósito.",
    };
  }
  return {
    code: "penalty",
    outcome: "cancel_penalty",
    daysAhead: Math.floor(days),
    title: "Penalidad",
    detail: "Faltan menos de 3 días y el equipo no se entregó. Se retiene el arrendamiento y la tarifa de servicio. La protección se devuelve porque la máquina no salió. El depósito se libera.",
  };
}
