import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pidFile = path.join(root, ".demo-pids.json");
const children = [];
let stopping = false;

if (existsSync(pidFile)) {
  try {
    for (const pid of JSON.parse(readFileSync(pidFile, "utf8"))) {
      try { process.kill(pid); } catch { /* el proceso ya no estaba */ }
    }
  } catch { /* archivo viejo ilegible */ }
  await new Promise((resolve) => setTimeout(resolve, 800));
}
for (let attempt = 0; attempt < 8; attempt += 1) {
  try {
    rmSync(path.join(root, "data"), { recursive: true, force: true });
    break;
  } catch (error) {
    if (attempt === 7) throw error;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
mkdirSync(path.join(root, "data"), { recursive: true });
await new Promise((resolve) => setTimeout(resolve, 400));

const sharedEnv = {
  ...process.env,
  INTERNAL_TOKEN: "maquirent-demo-internal",
  BUS_URL: "http://127.0.0.1:4200",
  GLOBAL_URL: "http://127.0.0.1:4000",
  CELL_CO_URL: "http://127.0.0.1:4101",
  CELL_US_URL: "http://127.0.0.1:4102",
  CELL_BR_URL: "http://127.0.0.1:4103",
  CELL_DE_URL: "http://127.0.0.1:4104",
  CELL_FR_URL: "http://127.0.0.1:4105",
};

function start(name, script, env) {
  const child = spawn(process.execPath, [script], { cwd: root, env: { ...sharedEnv, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const write = (chunk) => process.stdout.write(String(chunk));
  child.stdout.on("data", write);
  child.stderr.on("data", write);
  child.on("exit", (code) => {
    if (!stopping && code) {
      console.error(`${name} se detuvo (${code}).`);
      shutdown(1);
    }
  });
}

start("bus", "services/bus/server.js", { PORT: "4200", DB_PATH: path.join(root, "data", "bus.sqlite") });
start("global", "services/global/server.js", { PORT: "4000", DB_PATH: path.join(root, "data", "global.sqlite") });
for (const [cell, port] of [["CO", 4101], ["US", 4102], ["BR", 4103], ["DE", 4104], ["FR", 4105]]) {
  start(cell, "services/cell/server.js", { CELL: cell, PORT: String(port), DB_PATH: path.join(root, "data", `${cell.toLowerCase()}.sqlite`) });
}
start("web", "services/web/server.js", { PORT: "8080" });
writeFileSync(pidFile, JSON.stringify(children.map((child) => child.pid)));

const deadline = Date.now() + 30000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const response = await fetch("http://127.0.0.1:8080/api/global/health");
    const body = await response.json();
    const cellsUp = ["CO", "US", "BR", "DE", "FR"].every((code) => body.cells?.[code]?.up);
    if (body.catalog >= 15 && cellsUp) {
      ready = true;
      break;
    }
  } catch { /* todavía arrancando */ }
  await new Promise((resolve) => setTimeout(resolve, 400));
}

if (!ready) {
  console.error("MaquiRent no quedó listo a tiempo.");
  shutdown(1);
}

console.log("MaquiRent listo en http://localhost:8080");

function shutdown(code = 0) {
  stopping = true;
  for (const child of children) {
    try { child.kill(); } catch { /* ya cerrado */ }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
