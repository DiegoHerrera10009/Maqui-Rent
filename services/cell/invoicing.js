import { country } from "../../shared/countries.js";
import { id, nowIso } from "../../shared/ids.js";

export function issueInvoices(db, { cell, booking, plan, owner, renter }) {
  const existing = db.prepare("SELECT * FROM invoices WHERE booking_id = ? ORDER BY created_at").all(booking.id);
  if (existing.length) return existing.map(mapInvoice);
  if (!plan.rentalRecognized && !plan.serviceFee && !plan.ownerCommission) return [];
  const info = country(cell);
  const created = [];
  if (plan.rentalRecognized > 0) {
    created.push(insert(db, info, booking, {
      issuerRole: "owner",
      issuerName: owner.legal_name,
      recipientName: renter.legal_name,
      lines: [{ concept: "Arrendamiento de maquinaria", detail: "Lo factura el propietario. MaquiRent no es el arrendador.", amount: plan.rentalRecognized }],
      total: plan.rentalRecognized,
      taxEstimate: 0,
    }));
  }
  if (plan.ownerCommission > 0) {
    const tax = Math.round(plan.ownerCommission * info.taxRate);
    created.push(insert(db, info, booking, {
      issuerRole: "platform",
      issuerName: info.subsidiary,
      recipientName: owner.legal_name,
      lines: [{ concept: "Comisión de intermediación (8%)", detail: "La factura la emite la filial local, no la matriz.", amount: plan.ownerCommission }],
      total: plan.ownerCommission,
      taxEstimate: tax,
    }));
  }
  const renterPlatform = (plan.serviceFee || 0) + (plan.protectionPlatform || 0);
  if (renterPlatform > 0) {
    const lines = [];
    if (plan.serviceFee) lines.push({ concept: "Tarifa de servicio", detail: "La paga el arrendatario a la filial.", amount: plan.serviceFee });
    if (plan.protectionPlatform) lines.push({ concept: "Coordinación de la protección", detail: "Parte de la protección que corresponde a la plataforma. El resto lo retiene el asegurador en el split.", amount: plan.protectionPlatform });
    const tax = Math.round(renterPlatform * info.taxRate);
    created.push(insert(db, info, booking, {
      issuerRole: "platform",
      issuerName: info.subsidiary,
      recipientName: renter.legal_name,
      lines,
      total: renterPlatform,
      taxEstimate: tax,
    }));
  }
  return created;
}

function insert(db, info, booking, doc) {
  const row = {
    id: id("inv"),
    booking_id: booking.id,
    issuer_role: doc.issuerRole,
    issuer_name: doc.issuerName,
    recipient_name: doc.recipientName,
    doc_type: info.invoiceSystem,
    authority: info.taxAuthority,
    number: `${info.invoicePrefix}-${new Date().getUTCFullYear()}-${rowSuffix()}`,
    lines_json: JSON.stringify(doc.lines),
    total: doc.total,
    tax_estimate: doc.taxEstimate,
    currency: info.currency,
    created_at: nowIso(),
  };
  db.prepare(`INSERT INTO invoices
    (id, booking_id, issuer_role, issuer_name, recipient_name, doc_type, authority, number, lines_json, total, tax_estimate, currency, created_at)
    VALUES (@id, @booking_id, @issuer_role, @issuer_name, @recipient_name, @doc_type, @authority, @number, @lines_json, @total, @tax_estimate, @currency, @created_at)`).run(row);
  return mapInvoice(row);
}

function rowSuffix() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function invoicesOf(db, bookingId) {
  return db.prepare("SELECT * FROM invoices WHERE booking_id = ? ORDER BY created_at").all(bookingId).map(mapInvoice);
}

function mapInvoice(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    issuerRole: row.issuer_role,
    issuerName: row.issuer_name,
    recipientName: row.recipient_name,
    docType: row.doc_type,
    authority: row.authority,
    number: row.number,
    lines: JSON.parse(row.lines_json),
    total: row.total,
    taxEstimate: row.tax_estimate,
    taxNote: "Impuesto estimado, aparte del split. Un contador debe confirmar la base, el IVA o equivalente y las retenciones del marketplace.",
    currency: row.currency,
    createdAt: row.created_at,
  };
}
