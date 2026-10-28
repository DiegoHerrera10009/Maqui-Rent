import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function id(prefix = "id") {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function pseudonym(cell, userId) {
  const hash = createHash("sha256").update(`${cell}:${userId}:maquirent-v1`).digest("hex").slice(0, 12);
  return `usr_${hash}`;
}

export function evidenceHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const actual = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function daysBetween(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const diff = Math.round((end - start) / 86400000);
  if (!Number.isFinite(diff) || diff < 1) {
    const error = new Error("La devolución debe ser al menos un día después de la entrega.");
    error.status = 400;
    error.code = "bad_dates";
    throw error;
  }
  return diff;
}

export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}
