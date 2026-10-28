import { createServer } from "node:http";

export class HttpError extends Error {
  constructor(status, message, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, "El cuerpo de la petición es demasiado grande.", "payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization, x-internal-token",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
  });
  res.end(payload);
}

function matchPath(pattern, pathname) {
  const expected = pattern.split("/").filter(Boolean);
  const actual = pathname.split("/").filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params = {};
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i].startsWith(":")) params[expected[i].slice(1)] = decodeURIComponent(actual[i]);
    else if (expected[i] !== actual[i]) return null;
  }
  return params;
}

export function listen(port, routes) {
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, authorization, x-internal-token",
        "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
      });
      res.end();
      return;
    }
    try {
      const url = new URL(req.url, "http://localhost");
      let body = {};
      if (req.method !== "GET" && req.method !== "HEAD") {
        const raw = await readBody(req);
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            throw new HttpError(400, "El cuerpo no es JSON válido.", "bad_json");
          }
        }
      }
      const route = routes.find((item) => item.method === req.method && matchPath(item.path, url.pathname));
      if (!route) throw new HttpError(404, "Ruta no encontrada.", "not_found");
      const params = matchPath(route.path, url.pathname);
      const result = await route.handler({ req, url, body, params });
      send(res, result?.status || 200, result?.body ?? {});
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error(error);
      send(res, status, { error: error.message || "Error interno.", code: error.code || "error" });
    }
  });
  server.listen(port, "0.0.0.0");
  return server;
}
