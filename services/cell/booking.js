import { country } from "../../shared/countries.js";
import { CHECKLIST, PRINCIPLES, STATE_LABELS } from "../../shared/content.js";
import { cancellationPolicy, quoteRental, settlementPlan } from "../../shared/fees.js";
import { daysBetween, evidenceHash, id, nowIso, rangesOverlap } from "../../shared/ids.js";
import { schedule, transitMessage } from "../../shared/logistics.js";
import { HttpError } from "../../shared/http.js";
import { txn } from "./db.js";
import { enqueueMachine } from "./events.js";
import { issueInvoices, invoicesOf } from "./invoicing.js";
import { paymentsOf, recordPayment } from "./payments.js";

const BLOCKING = ["requested", "paid_held", "delivered", "returned", "disputed"];

export function createBooking(db, cell, renter, input) {
  return once(db, input.idempotencyKey, renter.id, () => {
    assertVerified(renter);
    const machine = mustMachine(db, input.machineId);
    if (machine.owner_id === renter.id) throw new HttpError(400, "El propietario no puede alquilarse su propia máquina.", "self_rent");
    if (machine.ownership_status !== "verified" || machine.active !== 1) {
      throw new HttpError(409, "La máquina todavía no tiene la propiedad verificada.", "not_bookable");
    }
    const days = daysBetween(input.startDate, input.endDate);
    const destination = renter.home_cell || cell;
    const logistics = schedule(cell, destination, input.startDate, input.endDate);
    if (logistics.tooSoon) throw new HttpError(409, transitMessage(logistics), "transit_time");
    const clash = db.prepare(`SELECT id, start_date, end_date, dispatch_date, return_by, state FROM bookings
      WHERE machine_id = ? AND state IN (${BLOCKING.map(() => "?").join(",")})`).all(machine.id, ...BLOCKING)
      .find((row) => rangesOverlap(
        logistics.dispatchDate,
        logistics.returnBy,
        row.dispatch_date || row.start_date,
        row.return_by || row.end_date,
      ));
    if (clash) {
      throw new HttpError(409, "Esa máquina ya está ocupada en esas fechas, contando el viaje de ida y de vuelta. Solo la celda del propietario confirma la reserva.", "double_booking");
    }
    if (machine.operator_required) {
      if (renter.operator_status !== "verified" || !renter.operator_certificate) {
        throw new HttpError(409, "Esta máquina exige un operador certificado y verificado antes de reservar.", "operator_required");
      }
    }
    const quote = quoteRental({
      cell,
      dailyRate: machine.daily_rate,
      startDate: input.startDate,
      endDate: input.endDate,
      freight: logistics.transport,
      logistics,
    });
    const bookingId = id("bkg");
    const timestamp = nowIso();
    db.prepare(`INSERT INTO bookings
      (id, machine_id, renter_id, state, start_date, end_date, quote_json, damage_claim, mediation_json, created_at, updated_at, dispatch_date, return_by)
      VALUES (?, ?, ?, 'requested', ?, ?, ?, 0, '[]', ?, ?, ?, ?)`).run(
      bookingId,
      machine.id,
      renter.id,
      input.startDate,
      input.endDate,
      JSON.stringify(quote),
      timestamp,
      timestamp,
      logistics.dispatchDate,
      logistics.returnBy,
    );
    step(db, bookingId, "booking.requested", { days, quote });
    enqueueMachine(db, cell, machine.id);
    return { status: 201, body: viewBooking(db, cell, bookingId, renter) };
  });
}

export function payBooking(db, cell, user, bookingId, input) {
  return once(db, input.idempotencyKey, user.id, () => {
    const booking = mustBooking(db, bookingId);
    assertParty(db, booking, user, "renter");
    assertState(booking, ["requested"]);
    const method = input.method === "bank_transfer" ? "bank_transfer" : "card";
    const quote = JSON.parse(booking.quote_json);
    const held = recordPayment(db, {
      cell,
      bookingId,
      method,
      kind: "escrow_hold",
      amount: quote.charged,
      currency: quote.currency,
      split: null,
    });
    const deposit = recordPayment(db, {
      cell,
      bookingId,
      method,
      kind: "deposit_hold",
      amount: quote.deposit,
      currency: quote.currency,
      split: null,
    });
    db.prepare("UPDATE bookings SET state = 'paid_held', payment_method = ?, deposit_status = 'held', updated_at = ? WHERE id = ?")
      .run(method, nowIso(), bookingId);
    step(db, bookingId, "payment.held", {
      provider: held.row.provider,
      method,
      escrow: held.row.reference,
      deposit: deposit.row.reference,
      replayedPayment: held.replay,
      note: "El procesador retiene el cobro. MaquiRent no lo recibe en cuenta propia.",
    });
    enqueueMachine(db, cell, booking.machine_id);
    return { status: 200, body: viewBooking(db, cell, bookingId, user) };
  });
}

export function deliverBooking(db, cell, user, bookingId, input) {
  return once(db, input.idempotencyKey, user.id, () => {
    const booking = mustBooking(db, bookingId);
    assertParty(db, booking, user);
    assertState(booking, ["paid_held"]);
    const act = saveAct(db, booking, user, "delivery", input);
    db.prepare("UPDATE bookings SET state = 'delivered', updated_at = ? WHERE id = ?").run(nowIso(), bookingId);
    db.prepare("UPDATE machines SET hour_meter = ? WHERE id = ?").run(act.hourMeter, booking.machine_id);
    step(db, bookingId, "act.delivery", { evidenceHash: act.evidenceHash, hourMeter: act.hourMeter });
    enqueueMachine(db, cell, booking.machine_id);
    return { status: 200, body: viewBooking(db, cell, bookingId, user) };
  });
}

export function returnBooking(db, cell, user, bookingId, input) {
  return once(db, input.idempotencyKey, user.id, () => {
    const booking = mustBooking(db, bookingId);
    assertParty(db, booking, user);
    assertState(booking, ["delivered"]);
    const delivery = db.prepare("SELECT hour_meter FROM acts WHERE booking_id = ? AND kind = 'delivery'").get(bookingId);
    if (Number(input.hourMeter) < delivery.hour_meter) {
      throw new HttpError(400, "El horómetro de devolución no puede ser menor que el de entrega.", "hour_meter");
    }
    const damage = Math.max(0, Math.round(Number(input.damageClaim) || 0));
    const act = saveAct(db, booking, user, "return", input);
    db.prepare("UPDATE bookings SET state = 'returned', damage_claim = ?, updated_at = ? WHERE id = ?").run(damage, nowIso(), bookingId);
    db.prepare("UPDATE machines SET hour_meter = ? WHERE id = ?").run(act.hourMeter, booking.machine_id);
    step(db, bookingId, "act.return", { evidenceHash: act.evidenceHash, hourMeter: act.hourMeter, damageClaim: damage });
    enqueueMachine(db, cell, booking.machine_id);
    return { status: 200, body: viewBooking(db, cell, bookingId, user) };
  });
}

export function settleBooking(db, cell, user, bookingId, input) {
  return once(db, input.idempotencyKey, user.id, () => {
    const booking = mustBooking(db, bookingId);
    assertParty(db, booking, user);
    assertState(booking, ["returned"]);
    applySettlement(db, cell, booking, "settle");
    return { status: 200, body: viewBooking(db, cell, bookingId, user) };
  });
}

export function cancelBooking(db, cell, user, bookingId, input) {
  return once(db, input.idempotencyKey, user.id, () => {
    const booking = mustBooking(db, bookingId);
    assertParty(db, booking, user);
    assertState(booking, ["requested", "paid_held"]);
    if (booking.state === "requested") {
      db.prepare("UPDATE bookings SET state = 'cancelled', resolution = 'withdrawn', updated_at = ? WHERE id = ?").run(nowIso(), bookingId);
      step(db, bookingId, "booking.cancelled", { reason: "Retirada antes del pago." });
    } else {
      const policy = cancellationPolicy(booking.start_date);
      applySettlement(db, cell, booking, policy.outcome, { policy });
    }
    enqueueMachine(db, cell, booking.machine_id);
    return { status: 200, body: viewBooking(db, cell, bookingId, user) };
  });
}

export function disputeBooking(db, cell, user, bookingId, input) {
  return once(db, input.idempotencyKey, user.id, () => {
    const booking = mustBooking(db, bookingId);
    assertParty(db, booking, user);
    assertState(booking, ["paid_held", "delivered", "returned"]);
    const note = cleanText(input.note, "Describe el conflicto.");
    const thread = JSON.parse(booking.mediation_json);
    thread.push({ at: nowIso(), author: user.legal_name, role: user.role, text: note });
    db.prepare("UPDATE bookings SET state = 'disputed', mediation_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(thread), nowIso(), bookingId);
    step(db, bookingId, "booking.disputed", { note });
    enqueueMachine(db, cell, booking.machine_id);
    return { status: 200, body: viewBooking(db, cell, bookingId, user) };
  });
}

export function mediateBooking(db, cell, user, bookingId, input) {
  return once(db, input.idempotencyKey, user.id, () => {
    const booking = mustBooking(db, bookingId);
    assertParty(db, booking, user);
    assertState(booking, ["disputed"]);
    const note = cleanText(input.note, "Escribe la nota de mediación.");
    const thread = JSON.parse(booking.mediation_json);
    thread.push({ at: nowIso(), author: user.legal_name, role: user.role, text: note });
    db.prepare("UPDATE bookings SET mediation_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(thread), nowIso(), bookingId);
    step(db, bookingId, "mediation.note", { note });
    return { status: 200, body: viewBooking(db, cell, bookingId, user) };
  });
}

export function resolveBooking(db, cell, user, bookingId, input) {
  return once(db, input.idempotencyKey, user.id, () => {
    const booking = mustBooking(db, bookingId);
    assertParty(db, booking, user);
    assertState(booking, ["disputed"]);
    const outcome = {
      release_owner: "dispute_release",
      refund_renter: "dispute_refund",
      split: "dispute_split",
    }[input.outcome];
    if (!outcome) throw new HttpError(400, "El acuerdo debe ser release_owner, refund_renter o split.", "bad_resolution");
    const thread = JSON.parse(booking.mediation_json);
    thread.push({
      at: nowIso(),
      author: user.legal_name,
      role: user.role,
      text: `Acuerdo de mediación: ${input.outcome}. Si las partes no lo aceptan, el paso siguiente es arbitraje o los tribunales de ${country(cell).forum}.`,
    });
    db.prepare("UPDATE bookings SET mediation_json = ? WHERE id = ?").run(JSON.stringify(thread), bookingId);
    applySettlement(db, cell, { ...booking, mediation_json: JSON.stringify(thread) }, outcome, { resolution: input.outcome });
    return { status: 200, body: viewBooking(db, cell, bookingId, user) };
  });
}

export function previewQuote(db, cell, machineId, startDate, endDate, homeCell) {
  const machine = mustMachine(db, machineId);
  const logistics = schedule(cell, homeCell || cell, startDate, endDate);
  if (logistics.tooSoon) throw new HttpError(409, transitMessage(logistics), "transit_time");
  const quote = quoteRental({
    cell,
    dailyRate: machine.daily_rate,
    startDate,
    endDate,
    freight: logistics.transport,
    logistics,
  });
  const policy = cancellationPolicy(startDate);
  return { machineId, quote, policy, blocks: blocksOf(db, machineId) };
}

export function viewBooking(db, cell, bookingId, viewer) {
  const booking = mustBooking(db, bookingId);
  if (viewer) assertParty(db, booking, viewer);
  const machine = mustMachine(db, booking.machine_id);
  const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(machine.owner_id);
  const renter = db.prepare("SELECT * FROM users WHERE id = ?").get(booking.renter_id);
  const info = country(cell);
  return {
    id: booking.id,
    cell,
    state: booking.state,
    stateLabel: STATE_LABELS[booking.state],
    startDate: booking.start_date,
    endDate: booking.end_date,
    dispatchDate: booking.dispatch_date,
    returnBy: booking.return_by,
    side: viewer && machine.owner_id === viewer.id ? "owner" : "renter",
    quote: JSON.parse(booking.quote_json),
    paymentMethod: booking.payment_method,
    depositStatus: booking.deposit_status,
    damageClaim: booking.damage_claim,
    mediation: JSON.parse(booking.mediation_json),
    resolution: booking.resolution,
    settlement: booking.settlement_json ? JSON.parse(booking.settlement_json) : null,
    machine: publicMachine(machine, owner),
    parties: {
      owner: party(owner),
      renter: party(renter),
    },
    acts: db.prepare("SELECT * FROM acts WHERE booking_id = ? ORDER BY created_at").all(bookingId).map(mapAct),
    payments: paymentsOf(db, bookingId),
    invoices: invoicesOf(db, bookingId),
    steps: db.prepare("SELECT * FROM saga_steps WHERE booking_id = ? ORDER BY created_at").all(bookingId).map((row) => ({
      id: row.id,
      step: row.step,
      detail: JSON.parse(row.detail_json),
      createdAt: row.created_at,
    })),
    cancellation: ["requested", "paid_held"].includes(booking.state) ? cancellationPolicy(booking.start_date) : null,
    forum: info.forum,
    intermediary: PRINCIPLES.role,
    createdAt: booking.created_at,
    updatedAt: booking.updated_at,
  };
}

export function contractFor(db, cell, user, bookingId) {
  const booking = viewBooking(db, cell, bookingId, user);
  const info = country(cell);
  return {
    title: "Contrato de arrendamiento de maquinaria",
    country: info.name,
    language: info.language,
    forum: info.forum,
    role: PRINCIPLES.role,
    subsidiary: info.subsidiary,
    provider: info.provider,
    clauses: [
      `Arrendador: ${booking.parties.owner.legalName} (${info.taxIdLabel} ${booking.parties.owner.taxId}).`,
      `Arrendatario: ${booking.parties.renter.legalName} (${info.taxIdLabel} ${booking.parties.renter.taxId}).`,
      `${info.subsidiary} interviene solo como intermediario tecnológico. No es parte de este arrendamiento y no custodia el precio.`,
      `Equipo: ${booking.machine.title}, ciudad ${booking.machine.city}. Entrega ${booking.startDate}, devolución ${booking.endDate}.${booking.quote.logistics ? ` Sale el ${booking.quote.logistics.dispatchDate} y vuelve a estar libre el ${booking.quote.logistics.returnBy} (${booking.quote.logistics.transitDays} días de transporte, ${booking.quote.logistics.mode}). El flete lo cobra el transportista.` : ""}`,
      `Precio del arrendamiento: lo factura el arrendador. La comisión, la tarifa de servicio y la coordinación de la protección las factura ${info.subsidiary}.`,
      `El cobro retenido lo ejecuta ${info.provider} mediante split. El depósito garantiza daño o pérdida y se captura solo si el acta de devolución lo declara.`,
      booking.machine.operatorRequired
        ? `El arrendatario designa un operador certificado (${booking.parties.renter.operatorCertificate || "pendiente"}). ${info.safetyNote}`
        : info.safetyNote,
      "El estado del equipo se fija en el acta de entrega y en el acta de devolución. Esas actas incluyen fotos, horómetro, checklist y ubicación.",
      `Ley y foro: ${info.name}. Sede ${info.forum}. Antes de acudir a arbitraje o a esos tribunales, las partes usan la mediación de la plataforma.`,
      `Protección de datos: ${info.privacyLaw}. ${info.privacyNote}`,
    ],
    booking,
  };
}

function applySettlement(db, cell, booking, outcome, extra = {}) {
  const quote = JSON.parse(booking.quote_json);
  const plan = settlementPlan(quote, outcome);
  const method = booking.payment_method || "card";
  if (booking.state !== "requested") {
    recordPayment(db, {
      cell,
      bookingId: booking.id,
      method,
      kind: plan.captured > 0 ? "split_capture" : "escrow_release",
      amount: plan.captured,
      currency: quote.currency,
      split: {
        owner: plan.ownerPayout,
        platform: plan.platformNet,
        insurer: plan.insurer,
        processor: plan.processorFee,
        carrier: plan.carrier || 0,
        refundToRenter: plan.refund,
      },
    });
    const damage = booking.damage_claim || 0;
    const captureDeposit = (outcome === "settle" || outcome === "dispute_release") ? Math.min(quote.deposit, damage) : 0;
    recordPayment(db, {
      cell,
      bookingId: booking.id,
      method,
      kind: captureDeposit > 0 ? "deposit_capture" : "deposit_release",
      amount: captureDeposit > 0 ? captureDeposit : quote.deposit,
      currency: quote.currency,
      split: captureDeposit > 0 ? { owner: captureDeposit } : { released: quote.deposit },
    });
  }
  const owner = db.prepare("SELECT * FROM users WHERE id = (SELECT owner_id FROM machines WHERE id = ?)").get(booking.machine_id);
  const renter = db.prepare("SELECT * FROM users WHERE id = ?").get(booking.renter_id);
  const invoices = issueInvoices(db, { cell, booking, plan, owner, renter });
  const next = outcome === "cancel_full" || outcome === "dispute_refund" ? "cancelled" : outcome.startsWith("cancel_") ? "cancelled" : "settled";
  db.prepare("UPDATE bookings SET state = ?, settlement_json = ?, resolution = ?, deposit_status = ?, updated_at = ? WHERE id = ?").run(
    next,
    JSON.stringify(plan),
    extra.resolution || extra.policy?.code || outcome,
    (outcome === "settle" || outcome === "dispute_release") && booking.damage_claim > 0 ? "captured_or_partial" : "released",
    nowIso(),
    booking.id,
  );
  step(db, booking.id, next === "cancelled" ? "booking.cancelled" : "payment.settled", {
    outcome,
    plan,
    invoices: invoices.map((item) => item.number),
    policy: extra.policy || null,
  });
  enqueueMachine(db, cell, booking.machine_id);
}

function saveAct(db, booking, user, kind, input) {
  if (!input.jointAcceptance) {
    throw new HttpError(400, "Las dos partes deben aceptar el acta en el punto de entrega o devolución.", "joint_acceptance");
  }
  const checklist = normalizeChecklist(input.checklist);
  const photos = normalizePhotos(input.photos);
  const hourMeter = Math.round(Number(input.hourMeter));
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!Number.isFinite(hourMeter) || hourMeter < 0) throw new HttpError(400, "Indica el horómetro.", "hour_meter");
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(400, "Indica la ubicación del acta.", "geo");
  const notes = String(input.notes || "").slice(0, 1000);
  const evidence = {
    bookingId: booking.id,
    kind,
    hourMeter,
    checklist,
    photos,
    lat,
    lng,
    notes,
    actorId: user.id,
  };
  const row = {
    id: id("act"),
    booking_id: booking.id,
    kind,
    hour_meter: hourMeter,
    checklist_json: JSON.stringify(checklist),
    photos_json: JSON.stringify(photos),
    lat,
    lng,
    notes,
    joint_acceptance: 1,
    actor_id: user.id,
    evidence_hash: evidenceHash(evidence),
    created_at: nowIso(),
  };
  db.prepare(`INSERT INTO acts
    (id, booking_id, kind, hour_meter, checklist_json, photos_json, lat, lng, notes, joint_acceptance, actor_id, evidence_hash, created_at)
    VALUES (@id, @booking_id, @kind, @hour_meter, @checklist_json, @photos_json, @lat, @lng, @notes, @joint_acceptance, @actor_id, @evidence_hash, @created_at)`).run(row);
  return mapAct(row);
}

function once(db, key, userId, fn) {
  const idempotencyKey = String(key || "").trim();
  if (!idempotencyKey) throw new HttpError(400, "Falta la clave de idempotencia.", "idempotency_key");
  return txn(db, () => {
    const previous = db.prepare("SELECT status, response_json FROM idempotency WHERE key = ?").get(idempotencyKey);
    if (previous) {
      return { status: previous.status, body: { ...JSON.parse(previous.response_json), replayed: true } };
    }
    const result = fn();
    db.prepare("INSERT INTO idempotency (key, user_id, status, response_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(idempotencyKey, userId, result.status || 200, JSON.stringify(result.body), nowIso());
    return result;
  });
}

function step(db, bookingId, name, detail) {
  db.prepare("INSERT INTO saga_steps (id, booking_id, step, detail_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id("step"), bookingId, name, JSON.stringify(detail), nowIso());
}

function mustMachine(db, machineId) {
  const machine = db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId);
  if (!machine) throw new HttpError(404, "La máquina no está en esta celda.", "machine_not_found");
  return machine;
}

function mustBooking(db, bookingId) {
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
  if (!booking) throw new HttpError(404, "La reserva no está en esta celda.", "booking_not_found");
  return booking;
}

function assertParty(db, booking, user, onlyRole) {
  const isRenter = booking.renter_id === user.id;
  const owner = db.prepare("SELECT owner_id FROM machines WHERE id = ?").get(booking.machine_id);
  const isOwner = owner?.owner_id === user.id;
  if (onlyRole === "renter" && !isRenter) throw new HttpError(403, "Solo el arrendatario puede hacer este paso.", "not_renter");
  if (!isRenter && !isOwner) throw new HttpError(403, "No participas en esta reserva.", "not_party");
}

function assertState(booking, allowed) {
  if (!allowed.includes(booking.state)) {
    throw new HttpError(409, `La reserva está en «${STATE_LABELS[booking.state]}» y ese paso no aplica.`, "bad_state");
  }
}

function assertVerified(user) {
  if (user.kyc_status !== "verified") {
    throw new HttpError(409, "La cuenta debe completar KYC o KYB antes de reservar o publicar.", "kyc_required");
  }
}

function party(user) {
  return {
    id: user.id,
    role: user.role,
    legalName: user.legal_name,
    taxId: user.tax_id,
    email: user.email,
    phone: user.phone,
    city: user.city,
    pseudonym: user.pseudonym,
    operatorCertificate: user.operator_certificate,
  };
}

export function publicMachine(machine, owner) {
  return {
    id: machine.id,
    title: machine.title,
    category: machine.category,
    brand: machine.brand,
    model: machine.model,
    year: machine.year,
    hourMeter: machine.hour_meter,
    dailyRate: machine.daily_rate,
    city: machine.city,
    lat: machine.lat,
    lng: machine.lng,
    description: machine.description,
    operatorRequired: Boolean(machine.operator_required),
    ownershipStatus: machine.ownership_status,
    bookable: machine.active === 1 && machine.ownership_status === "verified",
    tradeName: owner?.legal_name || null,
    ownerPseudonym: owner?.pseudonym || null,
    blocks: undefined,
  };
}

export function machineDetail(db, machine) {
  const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(machine.owner_id);
  return { ...publicMachine(machine, owner), blocks: blocksOf(db, machine.id), ownershipDoc: machine.ownership_doc };
}

function blocksOf(db, machineId) {
  return db.prepare(`SELECT COALESCE(dispatch_date, start_date) AS startDate, COALESCE(return_by, end_date) AS endDate, state FROM bookings
    WHERE machine_id = ? AND state NOT IN ('cancelled', 'settled') ORDER BY start_date`).all(machineId);
}

function mapAct(row) {
  return {
    id: row.id,
    kind: row.kind,
    hourMeter: row.hour_meter,
    checklist: JSON.parse(row.checklist_json),
    photos: JSON.parse(row.photos_json),
    lat: row.lat,
    lng: row.lng,
    notes: row.notes,
    jointAcceptance: Boolean(row.joint_acceptance),
    actorId: row.actor_id,
    evidenceHash: row.evidence_hash,
    createdAt: row.created_at,
  };
}

function normalizeChecklist(input) {
  const source = input && typeof input === "object" ? input : {};
  return CHECKLIST.map((label) => ({
    label,
    ok: source[label] === true || source[label] === "true" || source[label] === "on" || source[label] === "1",
  }));
}

function normalizePhotos(input) {
  const list = Array.isArray(input) ? input : String(input || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!list.length) throw new HttpError(400, "El acta necesita al menos una foto (nombre del archivo).", "photos");
  return list.slice(0, 8).map((item) => String(item.name || item).slice(0, 140));
}

function cleanText(value, message) {
  const text = String(value || "").trim();
  if (text.length < 8) throw new HttpError(400, message, "note");
  return text.slice(0, 1000);
}

export function listBookings(db, cell, user) {
  const rows = db.prepare(`SELECT DISTINCT b.id FROM bookings b
    LEFT JOIN machines m ON m.id = b.machine_id
    WHERE b.renter_id = ? OR m.owner_id = ?
    ORDER BY b.created_at DESC`).all(user.id, user.id);
  return rows.map((row) => viewBooking(db, cell, row.id, user));
}
