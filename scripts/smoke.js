const BASE = process.env.MAQUIRENT_URL || "http://127.0.0.1:8080";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(BASE + path, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function login(cell, email) {
  const result = await call(`/api/cells/${cell}/auth/login`, { method: "POST", body: { email, password: "demo123" } });
  assert(result.status === 200, `login ${cell} ${result.status} ${result.data.error}`);
  return result.data.token;
}

const deadline = Date.now() + 20000;
let health;
while (Date.now() < deadline) {
  health = await call("/api/global/health");
  if (health.status === 200 && health.data.catalog >= 15) break;
  await new Promise((resolve) => setTimeout(resolve, 400));
}
assert(health.data.catalog >= 15, "el índice global no recibió las máquinas");
assert(["CO", "US", "BR", "DE", "FR"].every((cell) => health.data.cells[cell].up), "alguna celda no respondió");

const search = await call("/api/global/search?q=Bagger");
assert(search.data.machines.some((machine) => machine.cell === "DE"), "la búsqueda global no encontró la máquina alemana");
const identities = await call("/api/global/identities");
assert(!JSON.stringify(identities.data).includes("@"), "el directorio global filtró un correo");

const token = await login("CO", "obras.andinas@demo.co");
const tooSoon = await call("/api/abroad/FR/bookings", {
  method: "POST",
  token,
  body: { homeCell: "CO", machineId: "fr-volvo-ec220", startDate: "2026-11-02", endDate: "2026-11-06", idempotencyKey: "cross-soon" },
});
assert(tooSoon.status === 409 && tooSoon.data.code === "transit_time", `se esperaba rechazo por el viaje, llegó ${tooSoon.status} ${tooSoon.data.code} ${tooSoon.data.error}`);
const abroad = await call("/api/abroad/FR/bookings", {
  method: "POST",
  token,
  body: { homeCell: "CO", machineId: "fr-volvo-ec220", startDate: "2026-12-20", endDate: "2026-12-24", idempotencyKey: "cross-ok" },
});
assert(abroad.status === 201, abroad.data.error || "no se reservó la máquina francesa");
assert(abroad.data.quote.logistics.transitDays === 23, "el viaje Colombia-Francia no tardó 23 días");
assert(abroad.data.quote.transport > 0, "el flete no entró en la cotización");
assert(abroad.data.dispatchDate < abroad.data.startDate, "la máquina no sale antes de la entrega");
const listed = await call("/api/my/bookings?homeCell=CO", { token });
assert(listed.data.bookings.some((booking) => booking.id === abroad.data.id && booking.cell === "FR"), "el alquiler en Francia no aparece en la cuenta de Colombia");

const created = await call("/api/cells/CO/bookings", {
  method: "POST",
  token,
  body: { homeCell: "CO", machineId: "co-cat-320", startDate: "2026-12-10", endDate: "2026-12-14", idempotencyKey: "co-book-1" },
});
assert(created.status === 201, created.data.error || "no se creó la reserva");
const again = await call("/api/cells/CO/bookings", {
  method: "POST",
  token,
  body: { homeCell: "CO", machineId: "co-cat-320", startDate: "2026-12-11", endDate: "2026-12-13", idempotencyKey: "co-book-2" },
});
assert(again.status === 409 && again.data.code === "double_booking", "la doble reserva no fue rechazada");

const pay = await call(`/api/cells/CO/bookings/${created.data.id}/pay`, {
  method: "POST",
  token,
  body: { method: "card", idempotencyKey: "co-pay-1" },
});
assert(pay.status === 200 && pay.data.state === "paid_held", "el pago retenido no quedó registrado");
const payAgain = await call(`/api/cells/CO/bookings/${created.data.id}/pay`, {
  method: "POST",
  token,
  body: { method: "card", idempotencyKey: "co-pay-1" },
});
assert(payAgain.data.replayed === true, "el segundo pago no fue idempotente");
assert(payAgain.data.payments.length === 2, "el reintento duplicó el cobro");

const act = {
  hourMeter: 4200,
  lat: 4.71,
  lng: -74.07,
  photos: ["frente.jpg", "horometro.jpg"],
  checklist: { "Horómetro legible": true },
  jointAcceptance: true,
  notes: "Entrega en obra, sin fugas.",
};
const delivered = await call(`/api/cells/CO/bookings/${created.data.id}/deliver`, {
  method: "POST",
  token,
  body: { ...act, idempotencyKey: "co-deliver-1" },
});
assert(delivered.data.state === "delivered", delivered.data.error || "no pasó a entregada");
const returned = await call(`/api/cells/CO/bookings/${created.data.id}/return`, {
  method: "POST",
  token,
  body: { ...act, hourMeter: 4212, damageClaim: 500000, idempotencyKey: "co-return-1" },
});
assert(returned.data.state === "returned", returned.data.error || "no pasó a devuelta");
const settled = await call(`/api/cells/CO/bookings/${created.data.id}/settle`, {
  method: "POST",
  token,
  body: { idempotencyKey: "co-settle-1" },
});
assert(settled.data.state === "settled", settled.data.error || "no liquidó");
assert(settled.data.invoices.some((invoice) => invoice.issuerRole === "owner"), "falta la factura del propietario");
assert(settled.data.invoices.some((invoice) => invoice.issuerRole === "platform"), "falta la factura de la filial");
assert(settled.data.payments.some((payment) => payment.kind === "split_capture" && payment.custody === "processor"), "el split no quedó en el procesador");
assert(settled.data.payments.some((payment) => payment.kind === "deposit_capture"), "el daño no capturó depósito");
const plan = settled.data.settlement;
assert(plan.ownerPayout + plan.platformNet + plan.insurer + plan.processorFee + plan.carrier === plan.captured, "el split de la liquidación no cierra");
assert(plan.carrier > 0, "el transportista no entró en el split");

const privacy = await call("/api/residency?email=ana.rios@demo.co");
const hits = privacy.data.cells.filter((cell) => cell.found).map((cell) => cell.code);
assert(hits.length === 1 && hits[0] === "CO", `el correo de Ana apareció en ${hits.join(",")}`);
assert(privacy.data.globalIndex.catalogHits === 0 && privacy.data.globalIndex.identityHits === 0 && privacy.data.globalIndex.eventHits === 0, "el plano global guardó el correo");
const copied = await call("/api/residency?email=obras.andinas@demo.co");
const copiedHits = copied.data.cells.filter((cell) => cell.found).map((cell) => cell.code).sort();
assert(copiedHits.join(",") === "CO,FR", `el contrato transfronterizo no copió el dato solo a Francia: ${copiedHits.join(",")}`);
assert(copied.data.globalIndex.catalogHits === 0 && copied.data.globalIndex.identityHits === 0, "el plano global guardó el correo del arrendatario");
const published = await call("/api/cells/CO/machines", {
  method: "POST",
  token,
  body: {
    title: "Compactador de la cuenta que alquila",
    category: "Compactación",
    brand: "Hamm",
    model: "H",
    year: 2020,
    hourMeter: 10,
    dailyRate: 500000,
    city: "Bogotá",
    description: "Equipo publicado por una cuenta que también alquila.",
    operatorRequired: false,
  },
});
assert(published.status === 201, published.data.error || "una cuenta que alquila no pudo publicar");

const incomplete = await call("/api/cells/CO/auth/register", {
  method: "POST",
  body: {
    role: "renter", legalName: "Sin Papeles S.A.S.", taxId: "900111222", email: "sin.papeles@demo.co",
    phone: "+57 300 000 0001", address: "Calle 2", city: "Bogotá", password: "demo1234", acceptTerms: true,
  },
});
assert(incomplete.status === 400 && incomplete.data.code === "dossier", "una empresa sin papeles pudo registrarse");
const fresh = await call("/api/cells/CO/auth/register", {
  method: "POST",
  body: {
    role: "renter", legalName: "Prueba Sin KYC S.A.S.", taxId: "900999111", email: "sin.kyc@demo.co",
    phone: "+57 300 000 0000", address: "Calle 1 # 2-3", city: "Bogotá", password: "demo1234", acceptTerms: true,
    dossier: {
      tradeName: "Prueba Sin KYC",
      legalForm: "S.A.S.",
      representativeName: "Ana Prueba",
      representativeId: "CC-1099000111",
      papers: {
        existence: { file: "camara-comercio.pdf" },
        taxRegistration: { file: "rut.pdf" },
        representativeId: { file: "cedula.pdf" },
        insurance: { file: "poliza.pdf", reference: "POL-900", insurer: "Sura", expires: "2027-06-01" },
        operator: { file: "operador.pdf", reference: "OP-900" },
      },
    },
  },
});
assert(fresh.status === 201, fresh.data.error || "no registró");
assert(fresh.data.user.kycStatus === "pending", "el expediente quedó habilitado sin revisión");
assert(fresh.data.user.dossier.papers.existence.file === "camara-comercio.pdf", "el certificado de cámara no quedó en el expediente");
const blocked = await call("/api/cells/CO/bookings", {
  method: "POST",
  token: fresh.data.token,
  body: { homeCell: "CO", machineId: "co-toyota-8f", startDate: "2026-12-10", endDate: "2026-12-12", idempotencyKey: "kyc-block" },
});
assert(blocked.data.code === "kyc_required", "un usuario sin KYC pudo reservar");

const cancelBooking = await call("/api/cells/CO/bookings", {
  method: "POST",
  token,
  body: { homeCell: "CO", machineId: "co-toyota-8f", startDate: "2026-12-20", endDate: "2026-12-22", idempotencyKey: "co-cancel-book" },
});
assert(cancelBooking.status === 201, cancelBooking.data.error || "no se creó la reserva cancelable");
await call(`/api/cells/CO/bookings/${cancelBooking.data.id}/pay`, {
  method: "POST",
  token,
  body: { method: "bank_transfer", idempotencyKey: "co-cancel-pay" },
});
const cancelled = await call(`/api/cells/CO/bookings/${cancelBooking.data.id}/cancel`, {
  method: "POST",
  token,
  body: { idempotencyKey: "co-cancel-do" },
});
assert(cancelled.data.state === "cancelled", cancelled.data.error || "la cancelación no aplicó la política");
assert(cancelled.data.payments.some((payment) => payment.kind === "escrow_release"), "el reembolso total no liberó el cobro");

const disputeBooking = await call("/api/cells/CO/bookings", {
  method: "POST",
  token,
  body: { homeCell: "CO", machineId: "co-jd-310", startDate: "2026-12-20", endDate: "2026-12-23", idempotencyKey: "co-dispute-book" },
});
assert(disputeBooking.status === 201, disputeBooking.data.error || "no se creó la reserva en disputa");
await call(`/api/cells/CO/bookings/${disputeBooking.data.id}/pay`, {
  method: "POST",
  token,
  body: { method: "card", idempotencyKey: "co-dispute-pay" },
});
const disputed = await call(`/api/cells/CO/bookings/${disputeBooking.data.id}/dispute`, {
  method: "POST",
  token,
  body: { note: "El equipo no coincide con el anuncio publicado.", idempotencyKey: "co-dispute-open" },
});
assert(disputed.data.state === "disputed", disputed.data.error || "no abrió la disputa");
const resolved = await call(`/api/cells/CO/bookings/${disputeBooking.data.id}/resolve`, {
  method: "POST",
  token,
  body: { outcome: "refund_renter", idempotencyKey: "co-dispute-resolve" },
});
assert(resolved.data.state === "cancelled", resolved.data.error || "la mediación no reembolsó");

const paused = await call("/api/control/DE", { method: "POST", body: { accepting: false } });
assert(paused.data.accepting === false, "Alemania no se pausó");
const german = await call("/api/cells/DE/machines");
assert(german.status === 503, "la celda pausada siguió vendiendo");
const colombian = await call("/api/cells/CO/machines");
assert(colombian.status === 200 && colombian.data.machines.length >= 3, "pausar Alemania afectó a Colombia");
await call("/api/control/DE", { method: "POST", body: { accepting: true } });

console.log("Humo de MaquiRent en orden: búsqueda, frontera, reserva única, saga, facturas, residencia y aislamiento.");
