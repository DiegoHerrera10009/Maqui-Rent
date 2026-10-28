import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNTS, DEMO_PASSWORD } from "../../shared/catalog.js";

const PORT = Number(process.env.PORT || 8080);
const GLOBAL_URL = process.env.GLOBAL_URL || "http://127.0.0.1:4000";
const TOKEN = process.env.INTERNAL_TOKEN || "maquirent-demo-internal";
const CELLS = {
  CO: process.env.CELL_CO_URL || "http://127.0.0.1:4101",
  US: process.env.CELL_US_URL || "http://127.0.0.1:4102",
  BR: process.env.CELL_BR_URL || "http://127.0.0.1:4103",
  DE: process.env.CELL_DE_URL || "http://127.0.0.1:4104",
  FR: process.env.CELL_FR_URL || "http://127.0.0.1:4105",
};
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function proxy(req, res, origin, pathname, search) {
  const dest = new URL(pathname + search, origin);
  const headers = { ...req.headers, host: dest.host };
  const upstream = http.request(dest, { method: req.method, headers }, (incoming) => {
    res.writeHead(incoming.statusCode || 502, incoming.headers);
    incoming.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) json(res, 503, { error: "Esa celda no responde. Las otras siguen disponibles.", code: "cell_down" });
  });
  req.pipe(upstream);
}

async function residency(email) {
  const cells = await Promise.all(Object.entries(CELLS).map(async ([code, origin]) => {
    try {
      const response = await fetch(`${origin}/internal/pii?email=${encodeURIComponent(email)}`, {
        headers: { "x-internal-token": TOKEN },
        signal: AbortSignal.timeout(2500),
      });
      const body = await response.json();
      return { code, reachable: response.ok, ...body };
    } catch {
      return { code, reachable: false, found: false };
    }
  }));
  let globalIndex = { emailStored: false, catalogHits: null, identityHits: null, eventHits: null };
  try {
    const response = await fetch(`${GLOBAL_URL}/privacy/email?email=${encodeURIComponent(email)}`, { signal: AbortSignal.timeout(2500) });
    globalIndex = await response.json();
  } catch {
    globalIndex = { emailStored: false, unreachable: true };
  }
  return { email, cells, globalIndex };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function cellFetch(origin, pathname, { method = "GET", auth = "", internal = false, body, search = "" } = {}) {
  const response = await fetch(origin + pathname + search, {
    method,
    headers: {
      ...(method !== "GET" && method !== "HEAD" ? { "content-type": "application/json" } : {}),
      ...(auth ? { authorization: auth } : {}),
      ...(internal ? { "x-internal-token": TOKEN } : {}),
    },
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function guestSession(machineCell, profile) {
  return cellFetch(CELLS[machineCell], "/internal/guest-token", {
    method: "POST",
    internal: true,
    body: {
      legalName: profile.legalName,
      taxId: profile.taxId,
      email: profile.email,
      phone: profile.phone,
      address: profile.address,
      city: profile.city,
      homeCell: profile.cell,
      kycStatus: profile.kycStatus,
      kycDoc: profile.kycDoc,
      operatorCertificate: profile.operatorCertificate,
      operatorStatus: profile.operatorStatus,
    },
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/demo") {
    json(res, 200, {
      source: "demo-seed",
      password: DEMO_PASSWORD,
      note: "Lista de acceso de la demo. No es el directorio del plano global: cada cuenta vive en la base de su país.",
      accounts: ACCOUNTS.map((account) => ({
        cell: account.cell,
        role: account.role,
        legalName: account.legalName,
        email: account.email,
        city: account.city,
      })),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/residency") {
    const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
    if (!email) return json(res, 400, { error: "Indica un correo.", code: "email" });
    json(res, 200, await residency(email));
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/control/")) {
    const code = url.pathname.split("/")[3];
    if (!CELLS[code]) return json(res, 404, { error: "Celda desconocida.", code: "unknown_cell" });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const response = await fetch(`${CELLS[code]}/internal/control`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": TOKEN },
      body: raw || "{}",
    });
    const body = await response.json();
    json(res, response.status, body);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/my/bookings") {
    const homeCell = url.searchParams.get("homeCell") || "";
    if (!CELLS[homeCell]) return json(res, 400, { error: "Indica el país de tu cuenta.", code: "home_cell" });
    const auth = req.headers.authorization || "";
    const me = await cellFetch(CELLS[homeCell], "/me", { auth });
    if (me.status !== 200) return json(res, me.status, me.data);
    const local = await cellFetch(CELLS[homeCell], "/bookings", { auth });
    if (local.status !== 200) return json(res, local.status, local.data);
    const links = await cellFetch(CELLS[homeCell], "/internal/remote-links", {
      internal: true,
      search: `?userId=${encodeURIComponent(me.data.id)}`,
    });
    const remote = [];
    for (const link of links.data.links || []) {
      if (!CELLS[link.cell]) continue;
      const guest = await guestSession(link.cell, me.data);
      if (guest.status !== 200) continue;
      const booking = await cellFetch(CELLS[link.cell], `/bookings/${link.bookingId}`, { auth: `Bearer ${guest.data.token}` });
      if (booking.status === 200) remote.push({ ...booking.data, cell: link.cell });
    }
    const bookings = [
      ...(local.data.bookings || []).map((booking) => ({ ...booking, cell: booking.cell || homeCell })),
      ...remote,
    ];
    json(res, 200, { bookings });
    return;
  }
  const abroad = url.pathname.match(/^\/api\/abroad\/([A-Z]{2})(\/.*)?$/);
  if (abroad) {
    const machineCell = abroad[1];
    const rest = abroad[2] || "/";
    if (!CELLS[machineCell]) return json(res, 404, { error: "Celda desconocida.", code: "unknown_cell" });
    let body = {};
    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: "El cuerpo no es JSON.", code: "json" });
      }
    }
    const homeCell = body.homeCell || url.searchParams.get("homeCell") || "";
    if (!CELLS[homeCell]) return json(res, 400, { error: "Indica el país de tu cuenta.", code: "home_cell" });
    if (homeCell === machineCell) return json(res, 400, { error: "Para un alquiler en tu país usa la celda de tu cuenta.", code: "same_country" });
    const me = await cellFetch(CELLS[homeCell], "/me", { auth: req.headers.authorization || "" });
    if (me.status !== 200) return json(res, me.status, me.data);
    const guest = await guestSession(machineCell, me.data);
    if (guest.status !== 200) return json(res, guest.status, guest.data);
    const result = await cellFetch(CELLS[machineCell], rest, {
      method: req.method,
      auth: `Bearer ${guest.data.token}`,
      body,
      search: url.search,
    });
    if (req.method === "POST" && rest === "/bookings" && result.status === 201 && result.data.id) {
      await cellFetch(CELLS[homeCell], "/internal/remote-link", {
        method: "POST",
        internal: true,
        body: { userId: me.data.id, cell: machineCell, bookingId: result.data.id },
      });
    }
    json(res, result.status, result.data);
    return;
  }
  if (url.pathname.startsWith("/api/global/")) {
    proxy(req, res, GLOBAL_URL, url.pathname.replace("/api/global", "") || "/", url.search);
    return;
  }
  const cellMatch = url.pathname.match(/^\/api\/cells\/([A-Z]{2})(\/.*)?$/);
  if (cellMatch) {
    if (!CELLS[cellMatch[1]]) return json(res, 404, { error: "Celda desconocida.", code: "unknown_cell" });
    proxy(req, res, CELLS[cellMatch[1]], cellMatch[2] || "/", url.search);
    return;
  }
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    json(res, 404, { error: "No encontrado.", code: "not_found" });
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
});

server.listen(PORT, "0.0.0.0", () => console.log(`[web] http://localhost:${PORT}`));
