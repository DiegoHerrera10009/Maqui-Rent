import { country } from "../../shared/countries.js";
import { id, nowIso } from "../../shared/ids.js";

export function paymentProvider(cell) {
  return country(cell);
}

function reference(provider, bookingId, kind) {
  return `${provider.toLowerCase().replace(/\s+/g, "_")}_${kind}_${bookingId}`;
}

export function recordPayment(db, { cell, bookingId, method, kind, amount, currency, split }) {
  const existing = db.prepare("SELECT * FROM payment_ledger WHERE booking_id = ? AND kind = ?").get(bookingId, kind);
  if (existing) return { row: mapPayment(existing), replay: true };
  const provider = paymentProvider(cell).provider;
  const row = {
    id: id("pay"),
    booking_id: bookingId,
    provider,
    method,
    kind,
    amount,
    currency,
    status: "recorded_by_processor",
    split_json: split ? JSON.stringify(split) : null,
    reference: reference(provider, bookingId, kind),
    created_at: nowIso(),
  };
  db.prepare(`INSERT INTO payment_ledger
    (id, booking_id, provider, method, kind, amount, currency, status, split_json, reference, created_at)
    VALUES (@id, @booking_id, @provider, @method, @kind, @amount, @currency, @status, @split_json, @reference, @created_at)`).run(row);
  return { row: mapPayment(row), replay: false };
}

export function paymentsOf(db, bookingId) {
  return db.prepare("SELECT * FROM payment_ledger WHERE booking_id = ? ORDER BY created_at").all(bookingId).map(mapPayment);
}

function mapPayment(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    provider: row.provider,
    method: row.method,
    kind: row.kind,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    split: row.split_json ? JSON.parse(row.split_json) : null,
    reference: row.reference,
    createdAt: row.created_at,
    custody: "processor",
  };
}
