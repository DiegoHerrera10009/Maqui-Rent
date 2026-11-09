import path from "node:path";
import { country } from "../../shared/countries.js";
import { CHECKLIST, PRINCIPLES } from "../../shared/content.js";
import { hashPassword, id, nowIso, pseudonym, verifyPassword } from "../../shared/ids.js";
import { routePlan } from "../../shared/logistics.js";
import { assertDossier } from "../../shared/onboarding.js";
import { decodePaperContent, ownershipDocument, paperDocument } from "../../shared/paperPreview.js";
import { normalizeMachinePhotos, parseMachinePhotos } from "../../shared/machinePhotos.js";
import { HttpError, listen } from "../../shared/http.js";
import {
  cancelBooking,
  contractFor,
  createBooking,
  deliverBooking,
  disputeBooking,
  listBookings,
  mediateBooking,
  payBooking,
  previewQuote,
  resolveBooking,
  returnBooking,
  settleBooking,
  viewBooking,
  machineDetail,
} from "./booking.js";
import { flag, openDatabase, setFlag, txn } from "./db.js";
import { enqueueIdentity, enqueueMachine, seed } from "./events.js";

const CELL = process.env.CELL || "CO";
const PORT = Number(process.env.PORT || 4101);
const DB_PATH = process.env.DB_PATH || path.resolve("data", `${CELL.toLowerCase()}.sqlite`);
const BUS_URL = process.env.BUS_URL || "http://127.0.0.1:4200";
const TOKEN = process.env.INTERNAL_TOKEN || "maquirent-demo-internal";
const info = country(CELL);
const db = openDatabase(DB_PATH);
txn(db, () => seed(db, CELL));

setInterval(() => {
  publishOutbox().catch((error) => console.error(`[${CELL}] bus: ${error.message}`));
}, 600);

async function publishOutbox() {
  if (flag(db, "hold_outbox")) return;
  const rows = db.prepare("SELECT * FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 30").all();
  for (const row of rows) {
    const response = await fetch(`${BUS_URL}/streams/catalog/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: row.id, type: row.type, data: JSON.parse(row.payload_json) }),
    });
    if (!response.ok) return;
    db.prepare("UPDATE outbox SET published_at = ? WHERE id = ?").run(nowIso(), row.id);
  }
}

function requireInternal(req) {
  if (req.headers["x-internal-token"] !== TOKEN) throw new HttpError(401, "Token interno inválido.", "internal");
}

function currentUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const session = db.prepare("SELECT user_id FROM sessions WHERE token = ?").get(token);
  if (!session) return null;
  return db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, "Inicia sesión en la celda de tu país.", "auth");
  return user;
}

function requireAdmin(req) {
  const user = requireUser(req);
  if (user.role !== "admin") throw new HttpError(403, "Solo la filial puede revisar papeles.", "not_admin");
  return user;
}

function reviewDecision(body) {
  const decision = body.decision === "approved" ? "approved" : body.decision === "rejected" ? "rejected" : "";
  if (!decision) throw new HttpError(400, "La decisión es aprobar o rechazar.", "decision");
  const note = String(body.note || "").trim();
  if (decision === "rejected" && note.length < 8) throw new HttpError(400, "Escribe el motivo del rechazo.", "note");
  return { decision, note };
}

function requireOpen() {
  if (!flag(db, "accepting")) {
    throw new HttpError(503, `La celda de ${info.name} no está recibiendo operaciones. El resto de países sigue activo.`, "cell_paused");
  }
}

function parseDossier(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function publicDossier(raw) {
  const dossier = parseDossier(raw);
  if (!dossier?.papers) return dossier;
  const papers = {};
  for (const [key, paper] of Object.entries(dossier.papers)) {
    papers[key] = {
      title: paper.title,
      file: paper.file,
      reference: paper.reference || null,
      insurer: paper.insurer || null,
      expires: paper.expires || null,
      mime: paper.mime || null,
      hasFile: true,
    };
  }
  return { ...dossier, papers };
}

function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    legalName: user.legal_name,
    taxId: user.tax_id,
    email: user.email,
    phone: user.phone,
    address: user.address,
    city: user.city,
    kycStatus: user.kyc_status,
    kycDoc: user.kyc_doc,
    kycNote: user.kyc_note || null,
    operatorCertificate: user.operator_certificate,
    operatorStatus: user.operator_status,
    operatorNote: user.operator_note || null,
    dossier: publicDossier(user.dossier_json),
    pseudonym: user.pseudonym,
    homeCell: user.home_cell || CELL,
    cell: CELL,
    country: info.name,
    language: info.language,
  };
}

function resolvePaper(user, paperKey) {
  const dossier = parseDossier(user.dossier_json) || {};
  const paper = dossier.papers?.[paperKey];
  if (!paper) throw new HttpError(404, "Ese papel no está en el expediente.", "paper_not_found");
  const stored = decodePaperContent(paper);
  if (stored) return stored;
  return paperDocument(
    {
      legalName: user.legal_name,
      taxId: user.tax_id,
      city: user.city,
      email: user.email,
      representativeName: dossier.representativeName,
      representativeId: dossier.representativeId,
    },
    paperKey,
    paper,
  );
}

function healthBody() {
  return {
    ok: true,
    cell: CELL,
    country: info.name,
    language: info.language,
    accepting: flag(db, "accepting"),
    holdOutbox: flag(db, "hold_outbox"),
    outboxPending: db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL").get().n,
    users: db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
    machines: db.prepare("SELECT COUNT(*) AS n FROM machines").get().n,
    provider: info.provider,
    invoiceSystem: info.invoiceSystem,
  };
}

listen(PORT, [
  { method: "GET", path: "/health", handler: () => ({ body: healthBody() }) },
  {
    method: "GET",
    path: "/legal",
    handler: () => ({
      body: {
        cell: CELL,
        country: info.name,
        language: info.language,
        subsidiary: info.subsidiary,
        parent: info.parent,
        subsidiaryTaxId: info.subsidiaryTaxId,
        taxIdLabel: info.taxIdLabel,
        forum: info.forum,
        provider: info.provider,
        invoiceSystem: info.invoiceSystem,
        taxAuthority: info.taxAuthority,
        taxName: info.taxName,
        taxRate: info.taxRate,
        privacyLaw: info.privacyLaw,
        privacyAuthority: info.privacyAuthority,
        privacyNote: info.privacyNote,
        safetyNote: info.safetyNote,
        bankNote: info.bankNote,
        principles: PRINCIPLES,
        checklist: CHECKLIST,
        documents: ["Términos y condiciones", "Política de privacidad", "Contrato de arrendamiento modelo", "Política de cancelación", "Reglas de uso de la plataforma"],
      },
    }),
  },
  {
    method: "POST",
    path: "/auth/register",
    handler: ({ body }) => {
      requireOpen();
      const required = ["role", "legalName", "taxId", "email", "phone", "address", "city", "password"];
      for (const field of required) {
        if (!String(body[field] || "").trim()) throw new HttpError(400, "Completa los datos de la cuenta y acepta el aviso de privacidad.", "fields");
      }
      if (!body.acceptTerms) throw new HttpError(400, "Debes aceptar los términos, la privacidad y las reglas de la plataforma.", "terms");
      if (String(body.password).length < 8) throw new HttpError(400, "La contraseña debe tener al menos 8 caracteres.", "password");
      if (!["owner", "renter"].includes(body.role)) throw new HttpError(400, "El rol es propietario o arrendatario.", "role");
      const dossier = assertDossier(CELL, body.dossier);
      const userId = id("usr");
      const row = {
        id: userId,
        role: body.role,
        legal_name: String(body.legalName).trim(),
        tax_id: String(body.taxId).trim(),
        email: String(body.email).trim().toLowerCase(),
        phone: String(body.phone).trim(),
        address: String(body.address).trim(),
        city: String(body.city).trim(),
        password_hash: hashPassword(String(body.password)),
        kyc_status: "pending",
        kyc_doc: dossier.kycDoc,
        operator_certificate: dossier.operatorCertificate,
        operator_status: "pending",
        pseudonym: pseudonym(CELL, userId),
        created_at: nowIso(),
        home_cell: CELL,
        dossier_json: JSON.stringify(dossier),
      };
      const token = id("tok");
      try {
        txn(db, () => {
          db.prepare(`INSERT INTO users
            (id, role, legal_name, tax_id, email, phone, address, city, password_hash, kyc_status, kyc_doc, operator_certificate, operator_status, pseudonym, created_at, home_cell, dossier_json)
            VALUES (@id, @role, @legal_name, @tax_id, @email, @phone, @address, @city, @password_hash, @kyc_status, @kyc_doc, @operator_certificate, @operator_status, @pseudonym, @created_at, @home_cell, @dossier_json)`).run(row);
          db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(token, userId, nowIso());
          enqueueIdentity(db, CELL, row);
        });
      } catch (error) {
        if (String(error.message).includes("UNIQUE")) throw new HttpError(409, "Ese correo ya está registrado en esta celda.", "email_taken");
        throw error;
      }
      return { status: 201, body: { token, user: publicUser(row) } };
    },
  },
  {
    method: "POST",
    path: "/auth/login",
    handler: ({ body }) => {
      requireOpen();
      const email = String(body.email || "").trim().toLowerCase();
      const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
      if (!user || !verifyPassword(String(body.password || ""), user.password_hash)) {
        throw new HttpError(401, "Correo o contraseña incorrectos en esta celda.", "credentials");
      }
      const token = id("tok");
      db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(token, user.id, nowIso());
      return { body: { token, user: publicUser(user) } };
    },
  },
  { method: "GET", path: "/me", handler: ({ req }) => ({ body: publicUser(requireUser(req)) }) },
  {
    method: "PATCH",
    path: "/me",
    handler: ({ req, body }) => {
      requireOpen();
      const user = requireUser(req);
      const certificate = String(body.operatorCertificate || "").trim();
      const kycDoc = String(body.kycDoc || user.kyc_doc || "").trim();
      if (certificate && certificate.length < 5) throw new HttpError(400, "El certificado del operador es demasiado corto.", "certificate");
      if (user.role === "admin") throw new HttpError(403, "La filial no completa un expediente de empresa.", "staff");
      db.prepare("UPDATE users SET operator_certificate = ?, operator_status = ?, operator_note = NULL, kyc_doc = ? WHERE id = ?").run(
        certificate || user.operator_certificate,
        certificate ? "pending" : user.operator_status,
        kycDoc || null,
        user.id,
      );
      return { body: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)) };
    },
  },
  {
    method: "POST",
    path: "/me/resubmit",
    handler: ({ req }) => {
      requireOpen();
      const user = requireUser(req);
      if (user.role === "admin") throw new HttpError(403, "La filial no reenvía su propio expediente.", "staff");
      if (user.kyc_status !== "rejected" && user.operator_status !== "rejected") {
        throw new HttpError(409, "No hay un rechazo que volver a enviar.", "not_rejected");
      }
      db.prepare(`UPDATE users SET
        kyc_status = CASE WHEN kyc_status = 'rejected' THEN 'pending' ELSE kyc_status END,
        kyc_note = CASE WHEN kyc_status = 'rejected' THEN NULL ELSE kyc_note END,
        operator_status = CASE WHEN operator_status = 'rejected' THEN 'pending' ELSE operator_status END,
        operator_note = CASE WHEN operator_status = 'rejected' THEN NULL ELSE operator_note END
        WHERE id = ?`).run(user.id);
      return { body: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)) };
    },
  },
  {
    method: "GET",
    path: "/admin/queue",
    handler: ({ req }) => {
      requireOpen();
      requireAdmin(req);
      const dossiers = db.prepare("SELECT * FROM users WHERE role != 'admin' AND kyc_status = 'pending' ORDER BY created_at").all().map(publicUser);
      const operators = db.prepare("SELECT * FROM users WHERE role != 'admin' AND kyc_status = 'verified' AND operator_status = 'pending' ORDER BY created_at").all().map(publicUser);
      const machines = db.prepare("SELECT * FROM machines WHERE ownership_status = 'pending' ORDER BY created_at").all().map((machine) => {
        const detail = machineDetail(db, machine, CELL);
        const owner = db.prepare("SELECT email FROM users WHERE id = ?").get(machine.owner_id);
        return { ...detail, ownerEmail: owner?.email || null };
      });
      return { body: { cell: CELL, dossiers, operators, machines } };
    },
  },
  {
    method: "GET",
    path: "/admin/users/:id/papers/:key",
    handler: ({ req, params }) => {
      requireOpen();
      requireAdmin(req);
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(params.id);
      if (!user || user.role === "admin") throw new HttpError(404, "Esa empresa no está en esta celda.", "user_not_found");
      return { body: resolvePaper(user, params.key) };
    },
  },
  {
    method: "GET",
    path: "/me/papers/:key",
    handler: ({ req, params }) => {
      requireOpen();
      const user = requireUser(req);
      if (user.role === "admin") throw new HttpError(403, "La filial abre los papeles desde la cola de revisión.", "staff");
      return { body: resolvePaper(user, params.key) };
    },
  },
  {
    method: "GET",
    path: "/admin/machines/:id/ownership",
    handler: ({ req, params }) => {
      requireOpen();
      requireAdmin(req);
      const machine = db.prepare("SELECT * FROM machines WHERE id = ?").get(params.id);
      if (!machine) throw new HttpError(404, "La máquina no está en esta celda.", "machine_not_found");
      if (!machine.ownership_doc) throw new HttpError(404, "Esa máquina no tiene factura o registro.", "ownership_doc");
      const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(machine.owner_id);
      return { body: ownershipDocument(machine, owner) };
    },
  },
  {
    method: "POST",
    path: "/admin/reviews",
    handler: ({ req, body }) => {
      requireOpen();
      const admin = requireAdmin(req);
      const { decision, note } = reviewDecision(body);
      const kind = String(body.kind || "");
      if (kind === "dossier" || kind === "operator") {
        const user = db.prepare("SELECT * FROM users WHERE id = ?").get(body.id);
        if (!user || user.role === "admin") throw new HttpError(404, "Esa empresa no está en esta celda.", "user_not_found");
        if (kind === "dossier") {
          if (user.kyc_status !== "pending") throw new HttpError(409, "Ese expediente ya no está en revisión.", "not_pending");
          if (decision === "approved") {
            db.prepare(`UPDATE users SET kyc_status = 'verified', kyc_note = NULL,
              operator_status = CASE WHEN operator_certificate IS NOT NULL AND length(operator_certificate) >= 5 THEN 'verified' ELSE operator_status END,
              operator_note = CASE WHEN operator_certificate IS NOT NULL AND length(operator_certificate) >= 5 THEN NULL ELSE operator_note END
              WHERE id = ?`).run(user.id);
          } else {
            db.prepare(`UPDATE users SET kyc_status = 'rejected', kyc_note = ?,
              operator_status = CASE WHEN operator_status = 'pending' THEN 'rejected' ELSE operator_status END,
              operator_note = CASE WHEN operator_status = 'pending' THEN ? ELSE operator_note END
              WHERE id = ?`).run(note, note, user.id);
          }
        } else {
          if (user.kyc_status !== "verified") throw new HttpError(409, "Primero se aprueba el expediente de la empresa.", "kyc_required");
          if (user.operator_status !== "pending") throw new HttpError(409, "Ese certificado ya no está en revisión.", "not_pending");
          if (!user.operator_certificate) throw new HttpError(400, "No hay número de certificado para revisar.", "certificate");
          db.prepare("UPDATE users SET operator_status = ?, operator_note = ? WHERE id = ?").run(
            decision === "approved" ? "verified" : "rejected",
            decision === "approved" ? null : note,
            user.id,
          );
        }
        return { body: { reviewer: admin.email, user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)) } };
      }
      if (kind === "ownership") {
        const machine = db.prepare("SELECT * FROM machines WHERE id = ?").get(body.id);
        if (!machine) throw new HttpError(404, "La máquina no está en esta celda.", "machine_not_found");
        if (machine.ownership_status !== "pending") throw new HttpError(409, "Esa publicación ya no está en revisión.", "not_pending");
        if (!machine.ownership_doc || machine.ownership_doc.length < 4) {
          throw new HttpError(400, "La máquina no tiene factura o registro para revisar.", "ownership_doc");
        }
        const updated = txn(db, () => {
          db.prepare("UPDATE machines SET ownership_status = ?, ownership_note = ? WHERE id = ?").run(
            decision === "approved" ? "verified" : "rejected",
            decision === "approved" ? null : note,
            machine.id,
          );
          enqueueMachine(db, CELL, machine.id);
          return machineDetail(db, db.prepare("SELECT * FROM machines WHERE id = ?").get(machine.id), CELL);
        });
        return { body: { reviewer: admin.email, machine: updated } };
      }
      throw new HttpError(400, "La revisión es de expediente, operador o publicación de máquina.", "kind");
    },
  },
  {
    method: "GET",
    path: "/machines",
    handler: () => {
      requireOpen();
      const rows = db.prepare("SELECT * FROM machines WHERE active = 1 ORDER BY title").all();
      return { body: { cell: CELL, machines: rows.map((machine) => machineDetail(db, machine, CELL)) } };
    },
  },
  {
    method: "GET",
    path: "/machines/:id",
    handler: ({ params }) => {
      requireOpen();
      const machine = db.prepare("SELECT * FROM machines WHERE id = ?").get(params.id);
      if (!machine) throw new HttpError(404, "La máquina no está en esta celda.", "machine_not_found");
      return { body: { cell: CELL, source: "cell", machine: machineDetail(db, machine, CELL) } };
    },
  },
  {
    method: "GET",
    path: "/machines/:id/photo/:index",
    handler: ({ params }) => {
      const machine = db.prepare("SELECT * FROM machines WHERE id = ?").get(params.id);
      if (!machine) throw new HttpError(404, "La máquina no está en esta celda.", "machine_not_found");
      const photos = parseMachinePhotos(machine.photos_json);
      const photo = photos[Number(params.index)];
      if (!photo?.content) throw new HttpError(404, "Esa foto no está en el anuncio.", "photo_not_found");
      return {
        status: 200,
        type: photo.mime || "image/jpeg",
        cache: "private, max-age=60",
        raw: Buffer.from(photo.content, "base64"),
      };
    },
  },
  {
    method: "POST",
    path: "/machines",
    handler: ({ req, body }) => {
      requireOpen();
      const user = requireUser(req);
      if (user.role === "admin") throw new HttpError(403, "La filial no publica maquinaria.", "staff");
      if ((user.home_cell || CELL) !== CELL) throw new HttpError(403, "Publica desde la celda de tu cuenta.", "foreign_account");
      if (user.kyc_status === "rejected") throw new HttpError(409, "La filial rechazó el expediente. El motivo está en la cuenta.", "kyc_rejected");
      if (user.kyc_status !== "verified") throw new HttpError(409, "La filial todavía no aprueba el expediente.", "kyc_required");
      const fields = ["title", "category", "brand", "model", "year", "hourMeter", "dailyRate", "city", "description"];
      for (const field of fields) {
        if (body[field] === undefined || body[field] === "") throw new HttpError(400, "Faltan datos de la máquina.", "fields");
      }
      const ownershipDoc = String(body.ownershipDoc || "").trim();
      if (ownershipDoc.length < 4) throw new HttpError(400, "Indica la factura o el registro del equipo. La filial lo revisa antes de publicar.", "ownership_doc");
      const photos = normalizeMachinePhotos(body.photos, { required: true });
      const majorRate = Number(body.dailyRate);
      if (!Number.isFinite(majorRate) || majorRate <= 0) throw new HttpError(400, "La tarifa diaria no es válida.", "rate");
      const machineId = id("mch");
      const created = txn(db, () => {
        db.prepare(`INSERT INTO machines
          (id, owner_id, category, brand, model, year, hour_meter, daily_rate, city, lat, lng, title, description, operator_required, ownership_status, ownership_doc, photos_json, active, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1, ?)`).run(
          machineId,
          user.id,
          String(body.category),
          String(body.brand),
          String(body.model),
          Number(body.year),
          Number(body.hourMeter),
          Math.round(majorRate * info.minorUnit),
          String(body.city),
          Number(body.lat) || infoLat(),
          Number(body.lng) || infoLng(),
          String(body.title),
          String(body.description),
          body.operatorRequired ? 1 : 0,
          ownershipDoc,
          JSON.stringify(photos),
          nowIso(),
        );
        enqueueMachine(db, CELL, machineId);
        return machineDetail(db, db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId), CELL);
      });
      return { status: 201, body: { machine: created } };
    },
  },
  {
    method: "POST",
    path: "/machines/:id/ownership",
    handler: ({ req, params, body }) => {
      requireOpen();
      const user = requireUser(req);
      if (user.role === "admin") throw new HttpError(403, "La filial no corrige la publicación: la aprueba o la rechaza.", "staff");
      const machine = db.prepare("SELECT * FROM machines WHERE id = ?").get(params.id);
      if (!machine || machine.owner_id !== user.id) throw new HttpError(403, "Solo quien publicó el equipo puede corregir la publicación.", "not_owner");
      if (machine.ownership_status !== "rejected") throw new HttpError(409, "Solo se corrige una publicación que la filial rechazó.", "not_rejected");
      const doc = String(body.ownershipDoc || "").trim();
      if (doc.length < 4) throw new HttpError(400, "Indica la factura o el registro del equipo.", "ownership_doc");
      const photos = body.photos ? normalizeMachinePhotos(body.photos, { required: true }) : parseMachinePhotos(machine.photos_json);
      if (!photos.length) throw new HttpError(400, "Sube al menos una foto de la máquina.", "photos_required");
      const updated = txn(db, () => {
        db.prepare("UPDATE machines SET ownership_status = 'pending', ownership_doc = ?, ownership_note = NULL, photos_json = ? WHERE id = ?")
          .run(doc, JSON.stringify(photos), machine.id);
        enqueueMachine(db, CELL, machine.id);
        return machineDetail(db, db.prepare("SELECT * FROM machines WHERE id = ?").get(machine.id), CELL);
      });
      return { body: { machine: updated } };
    },
  },
  {
    method: "GET",
    path: "/quote",
    handler: ({ url }) => {
      requireOpen();
      const machineId = url.searchParams.get("machineId");
      const startDate = url.searchParams.get("start");
      const endDate = url.searchParams.get("end");
      return { body: previewQuote(db, CELL, machineId, startDate, endDate, url.searchParams.get("homeCell") || CELL) };
    },
  },
  {
    method: "POST",
    path: "/bookings",
    handler: ({ req, body }) => {
      requireOpen();
      return createBooking(db, CELL, requireUser(req), body);
    },
  },
  { method: "GET", path: "/bookings", handler: ({ req }) => ({ body: { bookings: listBookings(db, CELL, requireUser(req)) } }) },
  { method: "GET", path: "/bookings/:id", handler: ({ req, params }) => ({ body: viewBooking(db, CELL, params.id, requireUser(req)) }) },
  { method: "GET", path: "/bookings/:id/contract", handler: ({ req, params }) => ({ body: contractFor(db, CELL, requireUser(req), params.id) }) },
  { method: "POST", path: "/bookings/:id/pay", handler: ({ req, params, body }) => guarded(() => payBooking(db, CELL, requireUser(req), params.id, body)) },
  { method: "POST", path: "/bookings/:id/deliver", handler: ({ req, params, body }) => guarded(() => deliverBooking(db, CELL, requireUser(req), params.id, body)) },
  { method: "POST", path: "/bookings/:id/return", handler: ({ req, params, body }) => guarded(() => returnBooking(db, CELL, requireUser(req), params.id, body)) },
  { method: "POST", path: "/bookings/:id/settle", handler: ({ req, params, body }) => guarded(() => settleBooking(db, CELL, requireUser(req), params.id, body)) },
  { method: "POST", path: "/bookings/:id/cancel", handler: ({ req, params, body }) => guarded(() => cancelBooking(db, CELL, requireUser(req), params.id, body)) },
  { method: "POST", path: "/bookings/:id/dispute", handler: ({ req, params, body }) => guarded(() => disputeBooking(db, CELL, requireUser(req), params.id, body)) },
  { method: "POST", path: "/bookings/:id/mediate", handler: ({ req, params, body }) => guarded(() => mediateBooking(db, CELL, requireUser(req), params.id, body)) },
  { method: "POST", path: "/bookings/:id/resolve", handler: ({ req, params, body }) => guarded(() => resolveBooking(db, CELL, requireUser(req), params.id, body)) },
  {
    method: "GET",
    path: "/internal/pii",
    handler: ({ req, url }) => {
      requireInternal(req);
      const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
      const user = email ? db.prepare("SELECT * FROM users WHERE email = ?").get(email) : null;
      if (!user) return { body: { cell: CELL, found: false } };
      return {
        body: {
          cell: CELL,
          found: true,
          legalName: user.legal_name,
          email: user.email,
          taxId: user.tax_id,
          phone: user.phone,
          address: user.address,
          city: user.city,
          role: user.role,
        },
      };
    },
  },
  {
    method: "POST",
    path: "/internal/control",
    handler: ({ req, body }) => {
      requireInternal(req);
      if (body.accepting !== undefined) setFlag(db, "accepting", Boolean(body.accepting));
      if (body.holdOutbox !== undefined) setFlag(db, "hold_outbox", Boolean(body.holdOutbox));
      return { body: healthBody() };
    },
  },
  {
    method: "GET",
    path: "/logistics",
    handler: ({ url }) => {
      const homeCell = url.searchParams.get("homeCell") || CELL;
      return { body: routePlan(CELL, homeCell) };
    },
  },
  {
    method: "POST",
    path: "/internal/guest-token",
    handler: ({ req, body }) => {
      requireInternal(req);
      requireOpen();
      const homeCell = String(body.homeCell || "");
      const email = String(body.email || "").trim().toLowerCase();
      if (!email || !homeCell || homeCell === CELL) {
        throw new HttpError(400, "La cuenta invitada tiene que venir de otro país.", "guest");
      }
      const kycStatus = ["verified", "rejected", "pending"].includes(body.kycStatus) ? body.kycStatus : "pending";
      const operatorStatus = ["verified", "rejected", "pending", "none"].includes(body.operatorStatus) ? body.operatorStatus : "none";
      const sessionToken = txn(db, () => {
        let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
        if (!user) {
          const userId = id("usr");
          const row = {
            id: userId,
            role: "renter",
            legal_name: String(body.legalName || "").trim() || email,
            tax_id: String(body.taxId || "").trim() || "pendiente",
            email,
            phone: String(body.phone || "").trim() || "-",
            address: String(body.address || "").trim() || "-",
            city: String(body.city || "").trim() || "-",
            password_hash: hashPassword(id("pw")),
            kyc_status: kycStatus,
            kyc_doc: body.kycDoc || null,
            operator_certificate: body.operatorCertificate || null,
            operator_status: operatorStatus,
            pseudonym: pseudonym(CELL, userId),
            created_at: nowIso(),
            home_cell: homeCell,
          };
          db.prepare(`INSERT INTO users
            (id, role, legal_name, tax_id, email, phone, address, city, password_hash, kyc_status, kyc_doc, operator_certificate, operator_status, pseudonym, created_at, home_cell)
            VALUES (@id, @role, @legal_name, @tax_id, @email, @phone, @address, @city, @password_hash, @kyc_status, @kyc_doc, @operator_certificate, @operator_status, @pseudonym, @created_at, @home_cell)`).run(row);
          enqueueIdentity(db, CELL, row);
          user = row;
        } else {
          db.prepare("UPDATE users SET kyc_status = ?, kyc_doc = ?, operator_certificate = ?, operator_status = ?, home_cell = ? WHERE id = ?").run(
            kycStatus,
            body.kycDoc || user.kyc_doc,
            body.operatorCertificate || user.operator_certificate,
            operatorStatus,
            homeCell,
            user.id,
          );
        }
        const token = id("tok");
        db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(token, user.id, nowIso());
        return token;
      });
      return { body: { token: sessionToken } };
    },
  },
  {
    method: "POST",
    path: "/internal/remote-link",
    handler: ({ req, body }) => {
      requireInternal(req);
      if (!body.userId || !body.cell || !body.bookingId) throw new HttpError(400, "Falta el vínculo del alquiler.", "link");
      db.prepare("INSERT OR IGNORE INTO remote_links (user_id, cell, booking_id, created_at) VALUES (?, ?, ?, ?)").run(
        body.userId,
        body.cell,
        body.bookingId,
        nowIso(),
      );
      return { body: { ok: true } };
    },
  },
  {
    method: "GET",
    path: "/internal/remote-links",
    handler: ({ req, url }) => {
      requireInternal(req);
      const userId = url.searchParams.get("userId") || "";
      const links = db.prepare("SELECT cell, booking_id AS bookingId FROM remote_links WHERE user_id = ? ORDER BY created_at DESC").all(userId);
      return { body: { links } };
    },
  },
]);

function guarded(fn) {
  requireOpen();
  return fn();
}

function infoLat() {
  return { CO: 4.71, US: 29.76, BR: -23.55, DE: 52.52, FR: 48.85 }[CELL];
}

function infoLng() {
  return { CO: -74.07, US: -95.37, BR: -46.63, DE: 13.4, FR: 2.35 }[CELL];
}

console.log(`[${CELL}] celda de ${info.name} en :${PORT}`);
