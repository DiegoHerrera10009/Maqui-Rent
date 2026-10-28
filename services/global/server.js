import path from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CELLS, COUNTRIES } from "../../shared/countries.js";
import { FEE, quoteRental } from "../../shared/fees.js";
import { CHECKLIST, GUARANTEES, JURY, PRINCIPLES, STATE_LABELS } from "../../shared/content.js";
import { FX } from "../../shared/fx.js";
import { ONBOARDING } from "../../shared/onboarding.js";
import { HttpError, listen } from "../../shared/http.js";

const PORT = Number(process.env.PORT || 4000);
const DB_PATH = process.env.DB_PATH || path.resolve("data", "global.sqlite");
const BUS_URL = process.env.BUS_URL || "http://127.0.0.1:4200";
mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS catalog (
    cell TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    category TEXT,
    brand TEXT,
    model TEXT,
    year INTEGER,
    city TEXT,
    lat REAL,
    lng REAL,
    title TEXT,
    description TEXT,
    daily_rate INTEGER,
    currency TEXT,
    hour_meter INTEGER,
    operator_required INTEGER,
    bookable INTEGER,
    ownership_verified INTEGER,
    owner_pseudonym TEXT,
    blocks_json TEXT,
    payload_json TEXT,
    updated_at TEXT,
    PRIMARY KEY (cell, machine_id)
  );
  CREATE TABLE IF NOT EXISTS identities (
    pseudonym TEXT PRIMARY KEY,
    cell TEXT NOT NULL,
    role TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS consumer_offset (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS applied_events (
    id TEXT PRIMARY KEY,
    type TEXT,
    cell TEXT,
    summary TEXT,
    payload_json TEXT,
    applied_at TEXT
  );
`);

const cellUrls = Object.fromEntries(CELLS.map((code) => [code, process.env[`CELL_${code}_URL`] || `http://127.0.0.1:${4101 + CELLS.indexOf(code)}`]));
const cellHealth = Object.fromEntries(CELLS.map((code) => [code, { up: false, accepting: false }]));

function countryCard(code) {
  const info = COUNTRIES[code];
  return {
    code,
    name: info.name,
    language: info.language,
    languageCode: info.languageCode,
    currency: info.currency,
    locale: info.locale,
    minorUnit: info.minorUnit,
    subsidiary: info.subsidiary,
    parent: info.parent,
    taxIdLabel: info.taxIdLabel,
    subsidiaryTaxId: info.subsidiaryTaxId,
    forum: info.forum,
    provider: info.provider,
    processorFeeRate: info.processorFeeRate,
    invoiceSystem: info.invoiceSystem,
    taxAuthority: info.taxAuthority,
    taxName: info.taxName,
    taxRate: info.taxRate,
    privacyLaw: info.privacyLaw,
    privacyAuthority: info.privacyAuthority,
    privacyNote: info.privacyNote,
    safetyNote: info.safetyNote,
    bankNote: info.bankNote,
  };
}

function applyEvent(event) {
  const data = event.data || {};
  if (event.type === "machine.upsert") {
    db.prepare(`INSERT INTO catalog
      (cell, machine_id, category, brand, model, year, city, lat, lng, title, description, daily_rate, currency, hour_meter, operator_required, bookable, ownership_verified, owner_pseudonym, blocks_json, payload_json, updated_at)
      VALUES (@cell, @machine_id, @category, @brand, @model, @year, @city, @lat, @lng, @title, @description, @daily_rate, @currency, @hour_meter, @operator_required, @bookable, @ownership_verified, @owner_pseudonym, @blocks_json, @payload_json, @updated_at)
      ON CONFLICT(cell, machine_id) DO UPDATE SET
        category = excluded.category, brand = excluded.brand, model = excluded.model, year = excluded.year,
        city = excluded.city, lat = excluded.lat, lng = excluded.lng, title = excluded.title, description = excluded.description,
        daily_rate = excluded.daily_rate, currency = excluded.currency, hour_meter = excluded.hour_meter,
        operator_required = excluded.operator_required, bookable = excluded.bookable, ownership_verified = excluded.ownership_verified,
        owner_pseudonym = excluded.owner_pseudonym, blocks_json = excluded.blocks_json, payload_json = excluded.payload_json, updated_at = excluded.updated_at`).run({
      cell: data.cell,
      machine_id: data.machineId,
      category: data.category,
      brand: data.brand,
      model: data.model,
      year: data.year,
      city: data.city,
      lat: data.lat,
      lng: data.lng,
      title: data.title,
      description: data.description,
      daily_rate: data.dailyRate,
      currency: COUNTRIES[data.cell].currency,
      hour_meter: data.hourMeter,
      operator_required: data.operatorRequired ? 1 : 0,
      bookable: data.bookable ? 1 : 0,
      ownership_verified: data.ownershipVerified ? 1 : 0,
      owner_pseudonym: data.ownerPseudonym,
      blocks_json: JSON.stringify(data.blocks || []),
      payload_json: JSON.stringify(data),
      updated_at: event.createdAt,
    });
  } else if (event.type === "identity.upsert") {
    db.prepare("INSERT INTO identities (pseudonym, cell, role) VALUES (?, ?, ?) ON CONFLICT(pseudonym) DO UPDATE SET cell = excluded.cell, role = excluded.role")
      .run(data.pseudonym, data.cell, data.role);
  }
  db.prepare("INSERT OR REPLACE INTO applied_events (id, type, cell, summary, payload_json, applied_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    event.id,
    event.type,
    data.cell || null,
    event.type === "machine.upsert" ? data.title : data.pseudonym,
    JSON.stringify(data),
    event.createdAt,
  );
}

async function pollBus() {
  const offset = db.prepare("SELECT seq FROM consumer_offset WHERE id = 'catalog'").get()?.seq || 0;
  const response = await fetch(`${BUS_URL}/streams/catalog/events?after=${offset}&limit=50`);
  if (!response.ok) return;
  const body = await response.json();
  for (const event of body.events) {
    applyEvent(event);
    db.prepare("INSERT INTO consumer_offset (id, seq) VALUES ('catalog', ?) ON CONFLICT(id) DO UPDATE SET seq = excluded.seq").run(event.seq);
  }
}

async function pollCells() {
  await Promise.all(CELLS.map(async (code) => {
    const started = Date.now();
    try {
      const response = await fetch(`${cellUrls[code]}/health`, { signal: AbortSignal.timeout(1500) });
      const body = await response.json();
      cellHealth[code] = { up: response.ok, accepting: Boolean(body.accepting), holdOutbox: Boolean(body.holdOutbox), outboxPending: body.outboxPending ?? null, latencyMs: Date.now() - started };
    } catch {
      cellHealth[code] = { up: false, accepting: false, latencyMs: Date.now() - started };
    }
  }));
}

setInterval(() => pollBus().catch((error) => console.error(`[global] bus: ${error.message}`)), 700);
setInterval(() => pollCells().catch(() => {}), 2000);
pollBus().catch(() => {});
pollCells().catch(() => {});

function mapMachine(row) {
  return {
    cell: row.cell,
    machineId: row.machine_id,
    category: row.category,
    brand: row.brand,
    model: row.model,
    year: row.year,
    city: row.city,
    lat: row.lat,
    lng: row.lng,
    title: row.title,
    description: row.description,
    dailyRate: row.daily_rate,
    currency: row.currency,
    hourMeter: row.hour_meter,
    operatorRequired: Boolean(row.operator_required),
    bookable: Boolean(row.bookable),
    ownershipVerified: Boolean(row.ownership_verified),
    ownerPseudonym: row.owner_pseudonym,
    blocks: JSON.parse(row.blocks_json || "[]"),
    country: COUNTRIES[row.cell].name,
    language: COUNTRIES[row.cell].language,
    updatedAt: row.updated_at,
  };
}

listen(PORT, [
  {
    method: "GET",
    path: "/health",
    handler: async () => {
      await pollCells();
      return {
        body: {
          ok: true,
          service: "global",
          catalog: db.prepare("SELECT COUNT(*) AS n FROM catalog").get().n,
          identities: db.prepare("SELECT COUNT(*) AS n FROM identities").get().n,
          cells: cellHealth,
        },
      };
    },
  },
  {
    method: "GET",
    path: "/brief",
    handler: () => ({
      body: {
        name: "MaquiRent",
        countries: CELLS.map(countryCard),
        guarantees: GUARANTEES,
        jury: JURY,
        principles: PRINCIPLES,
        states: STATE_LABELS,
        fees: FEE,
        checklist: CHECKLIST,
        fx: FX,
        onboarding: ONBOARDING,
      },
    }),
  },
  {
    method: "GET",
    path: "/search",
    handler: ({ url }) => {
      const q = (url.searchParams.get("q") || "").trim();
      const cell = url.searchParams.get("country") || "";
      const category = url.searchParams.get("category") || "";
      const includeUnverified = url.searchParams.get("includeUnverified") === "1";
      const like = `%${q.replace(/[\\%_]/g, "")}%`;
      const rows = db.prepare(`SELECT * FROM catalog
        WHERE (? = '' OR cell = ?)
          AND (? = '' OR category = ?)
          AND (? = '' OR title LIKE ? OR brand LIKE ? OR model LIKE ? OR city LIKE ? OR description LIKE ?)
          AND (? = 1 OR bookable = 1)
        ORDER BY cell, title`).all(cell, cell, category, category, q, like, like, like, like, like, includeUnverified ? 1 : 0);
      return { body: { total: rows.length, source: "global-index", consistency: "eventual", machines: rows.map(mapMachine) } };
    },
  },
  {
    method: "GET",
    path: "/machines/:cell/:id",
    handler: ({ params }) => {
      const row = db.prepare("SELECT * FROM catalog WHERE cell = ? AND machine_id = ?").get(params.cell, params.id);
      if (!row) throw new HttpError(404, "El índice global todavía no tiene esa máquina.", "not_indexed");
      return { body: { source: "global-index", machine: mapMachine(row) } };
    },
  },
  {
    method: "GET",
    path: "/identities",
    handler: () => ({
      body: {
        note: "Directorio mínimo del plano global. No hay correo, nombre, documento, teléfono ni dirección.",
        identities: db.prepare("SELECT pseudonym, cell, role FROM identities ORDER BY cell, role").all(),
      },
    }),
  },
  {
    method: "GET",
    path: "/feed",
    handler: () => ({
      body: {
        events: db.prepare("SELECT id, type, cell, summary, applied_at FROM applied_events ORDER BY applied_at DESC LIMIT 40").all(),
      },
    }),
  },
  {
    method: "GET",
    path: "/privacy/email",
    handler: ({ url }) => {
      const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
      if (!email) throw new HttpError(400, "Indica un correo.", "email");
      const catalogHits = db.prepare("SELECT COUNT(*) AS n FROM catalog WHERE payload_json LIKE ? OR owner_pseudonym LIKE ?").get(`%${email}%`, `%${email}%`).n;
      const identityHits = db.prepare("SELECT COUNT(*) AS n FROM identities WHERE pseudonym LIKE ? OR cell LIKE ? OR role LIKE ?").get(`%${email}%`, `%${email}%`, `%${email}%`).n;
      const eventHits = db.prepare("SELECT COUNT(*) AS n FROM applied_events WHERE payload_json LIKE ? OR summary LIKE ?").get(`%${email}%`, `%${email}%`).n;
      return {
        body: {
          emailStored: false,
          catalogHits,
          identityHits,
          eventHits,
          storedIdentityFields: ["pseudonym", "cell", "role"],
          note: "El plano global no tiene una columna de correo. El conteo recorre el índice y el directorio por si un evento hubiera filtrado el dato.",
        },
      };
    },
  },
  {
    method: "GET",
    path: "/quote",
    handler: ({ url }) => {
      const cell = url.searchParams.get("cell") || "CO";
      const dailyRate = Math.round(Number(url.searchParams.get("dailyRate") || 0));
      const days = Math.max(1, Math.round(Number(url.searchParams.get("days") || 1)));
      if (!CELLS.includes(cell) || dailyRate < 1) throw new HttpError(400, "Indica país y tarifa diaria.", "quote");
      const end = new Date(Date.UTC(2026, 11, 1 + days)).toISOString().slice(0, 10);
      const quote = quoteRental({ cell, dailyRate, startDate: "2026-12-01", endDate: end });
      return { body: { quote, fees: FEE, provider: COUNTRIES[cell].provider } };
    },
  },
]);

console.log(`[global] plano global en :${PORT}`);
