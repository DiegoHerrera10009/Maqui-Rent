import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export function openDatabase(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      legal_name TEXT NOT NULL,
      tax_id TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      kyc_status TEXT NOT NULL,
      kyc_doc TEXT,
      operator_certificate TEXT,
      operator_status TEXT NOT NULL,
      pseudonym TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      home_cell TEXT,
      dossier_json TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      category TEXT NOT NULL,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      year INTEGER NOT NULL,
      hour_meter INTEGER NOT NULL,
      daily_rate INTEGER NOT NULL,
      city TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      operator_required INTEGER NOT NULL,
      ownership_status TEXT NOT NULL,
      ownership_doc TEXT,
      active INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      renter_id TEXT NOT NULL,
      state TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      quote_json TEXT NOT NULL,
      payment_method TEXT,
      deposit_status TEXT,
      damage_claim INTEGER NOT NULL DEFAULT 0,
      mediation_json TEXT NOT NULL DEFAULT '[]',
      resolution TEXT,
      settlement_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dispatch_date TEXT,
      return_by TEXT
    );
    CREATE TABLE IF NOT EXISTS remote_links (
      user_id TEXT NOT NULL,
      cell TEXT NOT NULL,
      booking_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (cell, booking_id)
    );
    CREATE TABLE IF NOT EXISTS acts (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      hour_meter INTEGER NOT NULL,
      checklist_json TEXT NOT NULL,
      photos_json TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      notes TEXT,
      joint_acceptance INTEGER NOT NULL,
      actor_id TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_ledger (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      method TEXT NOT NULL,
      kind TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      split_json TEXT,
      reference TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (booking_id, kind)
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      issuer_role TEXT NOT NULL,
      issuer_name TEXT NOT NULL,
      recipient_name TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      authority TEXT NOT NULL,
      number TEXT NOT NULL,
      lines_json TEXT NOT NULL,
      total INTEGER NOT NULL,
      tax_estimate INTEGER NOT NULL,
      currency TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saga_steps (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      step TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      published_at TEXT
    );
    CREATE TABLE IF NOT EXISTS control (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  for (const sql of [
    "ALTER TABLE users ADD COLUMN home_cell TEXT",
    "ALTER TABLE bookings ADD COLUMN dispatch_date TEXT",
    "ALTER TABLE bookings ADD COLUMN return_by TEXT",
    "ALTER TABLE users ADD COLUMN dossier_json TEXT",
  ]) {
    try {
      db.exec(sql);
    } catch {
      /* la columna ya existe */
    }
  }
  db.prepare("INSERT OR IGNORE INTO control (key, value) VALUES ('accepting', '1')").run();
  db.prepare("INSERT OR IGNORE INTO control (key, value) VALUES ('hold_outbox', '0')").run();
  return db;
}

export function txn(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* la transacción ya estaba cerrada */
    }
    throw error;
  }
}

export function flag(db, key) {
  return db.prepare("SELECT value FROM control WHERE key = ?").get(key)?.value === "1";
}

export function setFlag(db, key, on) {
  db.prepare("INSERT INTO control (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, on ? "1" : "0");
}
