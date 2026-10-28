import { ACCOUNTS, DEMO_PASSWORD, MACHINES } from "../../shared/catalog.js";
import { hashPassword, id, nowIso, pseudonym } from "../../shared/ids.js";

export function seed(db, cell) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (count > 0) return { seeded: false };
  const passwordHash = hashPassword(DEMO_PASSWORD);
  const byEmail = new Map();
  for (const account of ACCOUNTS.filter((item) => item.cell === cell)) {
    const userId = id("usr");
    const row = {
      id: userId,
      role: account.role,
      legal_name: account.legalName,
      tax_id: account.taxId,
      email: account.email,
      phone: account.phone,
      address: account.address,
      city: account.city,
      password_hash: passwordHash,
      kyc_status: "verified",
      kyc_doc: account.kycDoc,
      operator_certificate: account.operatorCertificate || null,
      operator_status: account.operatorCertificate ? "verified" : "none",
      pseudonym: pseudonym(cell, userId),
      created_at: nowIso(),
      home_cell: cell,
    };
    db.prepare(`INSERT INTO users
      (id, role, legal_name, tax_id, email, phone, address, city, password_hash, kyc_status, kyc_doc, operator_certificate, operator_status, pseudonym, created_at, home_cell)
      VALUES (@id, @role, @legal_name, @tax_id, @email, @phone, @address, @city, @password_hash, @kyc_status, @kyc_doc, @operator_certificate, @operator_status, @pseudonym, @created_at, @home_cell)`).run(row);
    byEmail.set(account.email, row);
    enqueueIdentity(db, cell, row);
  }
  for (const machine of MACHINES.filter((item) => item.cell === cell)) {
    const owner = byEmail.get(machine.ownerEmail);
    db.prepare(`INSERT INTO machines
      (id, owner_id, category, brand, model, year, hour_meter, daily_rate, city, lat, lng, title, description, operator_required, ownership_status, ownership_doc, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, 1, ?)`).run(
      machine.id,
      owner.id,
      machine.category,
      machine.brand,
      machine.model,
      machine.year,
      machine.hourMeter,
      machine.dailyRate,
      machine.city,
      machine.lat,
      machine.lng,
      machine.title,
      machine.description,
      machine.operatorRequired ? 1 : 0,
      machine.ownershipDoc,
      nowIso(),
    );
    enqueueMachine(db, cell, machine.id);
  }
  return { seeded: true };
}

export function enqueueIdentity(db, cell, user) {
  db.prepare("INSERT INTO outbox (id, type, payload_json, created_at) VALUES (?, 'identity.upsert', ?, ?)").run(
    id("evt"),
    JSON.stringify({ pseudonym: user.pseudonym, cell, role: user.role }),
    nowIso(),
  );
}

export function enqueueMachine(db, cell, machineId) {
  const machine = db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId);
  const owner = db.prepare("SELECT pseudonym FROM users WHERE id = ?").get(machine.owner_id);
  const blocks = db.prepare(`SELECT COALESCE(dispatch_date, start_date) AS startDate, COALESCE(return_by, end_date) AS endDate, state
    FROM bookings WHERE machine_id = ? AND state NOT IN ('cancelled', 'settled')`).all(machineId);
  const payload = {
    cell,
    machineId: machine.id,
    category: machine.category,
    brand: machine.brand,
    model: machine.model,
    year: machine.year,
    city: machine.city,
    lat: machine.lat,
    lng: machine.lng,
    title: machine.title,
    description: machine.description,
    dailyRate: machine.daily_rate,
    hourMeter: machine.hour_meter,
    operatorRequired: Boolean(machine.operator_required),
    bookable: machine.active === 1 && machine.ownership_status === "verified",
    ownershipVerified: machine.ownership_status === "verified",
    ownerPseudonym: owner.pseudonym,
    blocks,
  };
  db.prepare("INSERT INTO outbox (id, type, payload_json, created_at) VALUES (?, 'machine.upsert', ?, ?)").run(id("evt"), JSON.stringify(payload), nowIso());
}
