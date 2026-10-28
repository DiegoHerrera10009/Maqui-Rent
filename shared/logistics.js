import { country } from "./countries.js";
import { usdToMinor } from "./fx.js";
import { HttpError } from "./http.js";

const LOCAL = { days: 2, usd: 650, mode: "camión local de ida y vuelta" };

const ROUTES = {
  "BR|CO": { days: 10, usd: 3900, mode: "terrestre y aduana" },
  "BR|DE": { days: 21, usd: 6800, mode: "marítimo y aduana" },
  "BR|FR": { days: 20, usd: 6600, mode: "marítimo y aduana" },
  "BR|US": { days: 14, usd: 5200, mode: "marítimo y aduana" },
  "CO|DE": { days: 24, usd: 7200, mode: "marítimo y aduana" },
  "CO|FR": { days: 23, usd: 7100, mode: "marítimo y aduana" },
  "CO|US": { days: 12, usd: 4800, mode: "marítimo y aduana" },
  "DE|FR": { days: 3, usd: 900, mode: "camión dentro de la Unión Europea" },
  "DE|US": { days: 16, usd: 6100, mode: "marítimo y aduana" },
  "FR|US": { days: 15, usd: 5900, mode: "marítimo y aduana" },
};

export function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function routeOf(origin, destination) {
  if (origin === destination) return LOCAL;
  const spec = ROUTES[[origin, destination].sort().join("|")];
  if (!spec) throw new HttpError(400, "No hay una ruta de transporte entre esos países.", "route");
  return spec;
}

export function routePlan(originCell, destinationCell) {
  const origin = country(originCell);
  const destination = country(destinationCell);
  const spec = routeOf(originCell, destinationCell);
  const today = todayIso();
  return {
    origin: originCell,
    destination: destinationCell,
    originName: origin.name,
    destinationName: destination.name,
    sameCountry: originCell === destinationCell,
    transitDays: spec.days,
    mode: spec.mode,
    roundTripUsd: spec.usd,
    transport: usdToMinor(spec.usd, origin.currency, origin.minorUnit),
    currency: origin.currency,
    earliestStart: addDays(today, spec.days),
  };
}

export function schedule(originCell, destinationCell, startDate, endDate) {
  const plan = routePlan(originCell, destinationCell);
  return {
    ...plan,
    dispatchDate: addDays(startDate, -plan.transitDays),
    returnBy: addDays(endDate, plan.transitDays),
    tooSoon: startDate < plan.earliestStart,
  };
}

export function transitMessage(plan) {
  if (plan.sameCountry) {
    return `El traslado local pide ${plan.transitDays} días de ida y vuelta. La entrega más temprana es ${plan.earliestStart}.`;
  }
  return `La máquina está en ${plan.originName} y tu cuenta está en ${plan.destinationName}. El viaje de ida y vuelta tarda ${plan.transitDays} días (${plan.mode}). No se puede entregar antes del ${plan.earliestStart}.`;
}
