import { CELL_LANG, LANGS, translate } from "./i18n.js";

const FLAGS = { CO: "CO", US: "US", BR: "BR", DE: "DE", FR: "FR" };
const FLOW = ["requested", "paid_held", "delivered", "returned", "settled"];
const PAY_LABELS = {
  escrow_hold: "Cobro retenido por el procesador",
  deposit_hold: "Depósito preautorizado",
  split_capture: "Split al liquidar",
  escrow_release: "Liberación del cobro sin captura",
  deposit_capture: "Captura del depósito por daño",
  deposit_release: "Liberación del depósito",
};

const app = document.querySelector("#app");
let brief = null;
let demo = null;
let session = JSON.parse(localStorage.getItem("maquirent.session") || "null");
let lastPath = "";
let rentalClock = null;
let pendingRentalClock = null;

function stopRentalClock() {
  if (rentalClock) {
    clearInterval(rentalClock);
    rentalClock = null;
  }
}

function formatSpan(ms) {
  if (ms == null) return "—";
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatWhen(value) {
  if (!value) return "Pendiente";
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return esc(value);
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: value.length === 10 ? undefined : "short",
    timeZone: "UTC",
  }).format(date);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function countryOf(cell) {
  return brief.countries.find((item) => item.code === cell);
}

function money(amount, cell) {
  const country = countryOf(cell);
  const local = new Intl.NumberFormat(country.locale, {
    style: "currency",
    currency: country.currency,
    maximumFractionDigits: country.minorUnit === 1 ? 0 : 2,
  }).format(Number(amount) / country.minorUnit);
  if (country.currency === "USD") return local;
  const perUsd = brief.fx?.perUsd?.[country.currency];
  if (!perUsd) return local;
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((Number(amount) / country.minorUnit) / perUsd);
  return `${local} <span class="usd">≈ ${usd}</span>`;
}

function cellPath(cell, suffix) {
  if (session && session.cell !== cell) {
    const joiner = suffix.includes("?") ? "&" : "?";
    return `/api/abroad/${cell}${suffix}${joiner}homeCell=${session.cell}`;
  }
  return `/api/cells/${cell}${suffix}`;
}

function currentLang() {
  const stored = localStorage.getItem("maquirent.lang");
  if (stored && LANGS.some((item) => item.code === stored)) return stored;
  if (session?.cell && CELL_LANG[session.cell]) return CELL_LANG[session.cell];
  return "es";
}

function t(key, vars) {
  return translate(currentLang(), key, vars);
}

function countryName(code) {
  return t(`country.${code}`);
}

function categoryName(name) {
  return t(`cat.${name}`);
}

function preferredCell() {
  if (session?.cell) return session.cell;
  return { es: "CO", en: "US", pt: "BR", de: "DE", fr: "FR" }[currentLang()] || "CO";
}

function setLang(code) {
  if (!LANGS.some((item) => item.code === code)) return;
  localStorage.setItem("maquirent.lang", code);
  document.documentElement.lang = code;
}

function pct(rate) {
  const locales = { es: "es-CO", en: "en-US", pt: "pt-BR", de: "de-DE", fr: "fr-FR" };
  return new Intl.NumberFormat(locales[currentLang()] || "es-CO", { style: "percent", maximumFractionDigits: 1 }).format(rate);
}

function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function nextDay(iso) {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function minDelivery(logistics) {
  const today = todayLocal();
  const earliest = logistics?.earliestStart;
  return earliest && earliest > today ? earliest : today;
}

function syncReturnMin(form) {
  const start = form.querySelector("[name=startDate]");
  const end = form.querySelector("[name=endDate]");
  if (!start || !end) return;
  const floor = start.min || todayLocal();
  const minEnd = start.value && start.value >= floor ? nextDay(start.value) : nextDay(floor);
  end.min = minEnd;
  if (end.value && end.value < minEnd) end.value = minEnd;
}

function assertBookDates(data, minStart) {
  const today = todayLocal();
  const floor = minStart && minStart > today ? minStart : today;
  if (!data.startDate) throw new Error(t("dates.needStart"));
  if (data.startDate < today) throw new Error(t("dates.past"));
  if (data.startDate < floor) throw new Error(t("dates.earliest", { date: floor }));
  if (!data.endDate || data.endDate <= data.startDate) throw new Error(t("dates.order"));
}

function saveSession(next) {
  session = next;
  if (next) localStorage.setItem("maquirent.session", JSON.stringify(next));
  else localStorage.removeItem("maquirent.session");
}

function showToast(message, bad = false) {
  const toast = document.querySelector("#toast");
  toast.hidden = false;
  toast.textContent = message;
  toast.className = bad ? "bad" : "";
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 4800);
}

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, query] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  return { path: `/${parts.join("/")}`, parts, params: new URLSearchParams(query || "") };
}

async function api(path, options = {}) {
  const headers = {};
  if (options.body) headers["content-type"] = "application/json";
  if (session?.token && (path.startsWith("/api/cells/") || path.startsWith("/api/abroad/") || path.startsWith("/api/my/"))) {
    headers.authorization = `Bearer ${session.token}`;
  }
  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || t("err.generic"));
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function navLink(href, label, extra = "") {
  const target = href.replace(/^#/, "").split("?")[0] || "/";
  const current = parseHash().path;
  const alias = target === "/explorar" && current === "/buscar";
  const active = current === target || alias;
  return `<a href="${href}" ${extra} ${active ? 'aria-current="page"' : ""}>${label}</a>`;
}

function shell(content) {
  const user = session?.user;
  const admin = user?.role === "admin";
  const lang = currentLang();
  return `<div class="wrap">
    <header class="top">
      <a class="logo" href="#/">Maqui<span>Rent</span></a>
      <nav>
        ${navLink("#/explorar", t("nav.explore"))}
        ${navLink("#/confianza", t("nav.trust"))}
        ${user ? navLink("#/cuenta", t("nav.account")) : ""}
        ${admin ? navLink("#/revision", t("nav.review")) : ""}
        ${user && !admin ? `${navLink("#/maquinas", t("nav.machines"))}${navLink("#/publicar", t("nav.publish"))}${navLink("#/alquileres", t("nav.bookings"))}` : ""}
        ${user ? `<a class="me" href="${admin ? "#/revision" : "#/cuenta"}">${esc(user.legalName)}</a><a href="#/" data-action="logout">${t("nav.logout")}</a>` : `${navLink("#/entrar", t("nav.login"))}${navLink("#/registro", t("nav.register"))}`}
        <label class="lang-pick"><span>${t("nav.language")}</span>
          <select name="uiLang" title="${esc(t("lang.hint"))}">${LANGS.map((item) => `<option value="${item.code}" ${item.code === lang ? "selected" : ""}>${esc(item.label)}</option>`).join("")}</select>
        </label>
      </nav>
    </header>
    <div class="rail">${brief.countries.map((country) => `<a href="#/explorar?country=${country.code}">${FLAGS[country.code]} ${esc(countryName(country.code))} · ${esc(country.language)}</a>`).join("")}</div>
    <main>${content}</main>
    <p class="footer">${t("footer")} ${esc(brief.fx.note)}</p>
  </div>`;
}

function photoOf(machine) {
  if (machine?.photoUrl) return machine.photoUrl;
  if (machine?.photos?.[0]?.url) return machine.photos[0].url;
  const cell = machine?.cell;
  const id = machine?.machineId || machine?.id;
  if (machine?.hasPhotos && cell && id) return `/api/cells/${cell}/machines/${id}/photo/0`;
  const known = ["co-cat-320", "co-toyota-8f", "co-jd-310", "co-grove-rt", "co-dynapac", "co-putz", "us-bobcat-t770", "us-jlg-600s", "us-cat-d6", "us-grove-tms", "us-putz-39", "us-bomag", "br-jcb-3cx", "br-liebherr-ltm", "br-schwing", "br-cat-336", "br-jlg-600", "br-dynapac", "de-liebherr-r920", "de-manitou", "de-hamm", "de-liebherr-ltm", "de-putz", "de-bobcat", "fr-volvo-ec220", "fr-haulotte", "fr-cat-cs", "fr-potain", "fr-jcb-3cx", "fr-putz"];
  return known.includes(id) ? `/machines/${id}.jpg` : "";
}

function machinePhotos(machine, cell = machine?.cell) {
  if (Array.isArray(machine?.photos) && machine.photos.length) {
    return machine.photos.map((photo) => photo.url).filter(Boolean);
  }
  const id = machine?.machineId || machine?.id;
  const count = Number(machine?.photoCount) || 0;
  if (count > 0 && cell && id) {
    return Array.from({ length: count }, (_, index) => `/api/cells/${cell}/machines/${id}/photo/${index}`);
  }
  const fallback = photoOf({ ...machine, cell, id });
  return fallback ? [fallback] : [];
}

function isMine(machine) {
  const mine = session?.user?.pseudonym;
  return Boolean(mine && machine.ownerPseudonym === mine);
}

function mixByCountry(machines) {
  const groups = new Map();
  for (const machine of machines) {
    const list = groups.get(machine.cell) || [];
    list.push(machine);
    groups.set(machine.cell, list);
  }
  const mixed = [];
  let index = 0;
  let added = true;
  while (added) {
    added = false;
    for (const list of groups.values()) {
      if (list[index]) {
        mixed.push(list[index]);
        added = true;
      }
    }
    index += 1;
  }
  return mixed;
}

function marketplace(machines) {
  const available = machines.filter((machine) => !isMine(machine));
  const home = preferredCell();
  const local = available.filter((machine) => machine.cell === home);
  const abroad = available.filter((machine) => machine.cell !== home);
  return [...local, ...mixByCountry(abroad)];
}

async function searchCatalog(params = new URLSearchParams()) {
  const query = new URLSearchParams(params);
  if (session?.user?.pseudonym) query.set("excludeOwner", session.user.pseudonym);
  return api(`/api/global/search?${query}`);
}

function machineCard(machine) {
  const photo = photoOf(machine);
  return `<a class="machine" href="#/maquina/${machine.cell}/${machine.machineId}">
    ${photo ? `<img class="shot" src="${photo}" alt="">` : ""}
    <div class="badges"><span class="badge">${FLAGS[machine.cell]} ${esc(countryName(machine.cell))}</span><span class="badge">${esc(machine.language)}</span><span class="badge">${esc(categoryName(machine.category))}</span></div>
    <h3>${esc(machine.title)}</h3>
    <p class="muted">${esc(machine.city)} · ${esc(machine.brand)} ${esc(machine.model)}</p>
    <p>${esc(machine.description)}</p>
    <div class="price">${money(machine.dailyRate, machine.cell)} <span class="muted">${t("card.day")}</span></div>
    <p class="muted">${machine.bookable ? t("card.verified") : t("card.pending")} · ${machine.blocks?.length ? t("card.blocked") : t("card.free")}</p>
  </a>`;
}

function billRow(label, hint, amount, cell) {
  return `<div class="bill-row"><span>${label}${hint ? `<small>${hint}</small>` : ""}</span><b>${money(amount, cell)}</b></div>`;
}

function economics(quote) {
  const cell = quote.cell;
  const transport = quote.logistics
    ? billRow(t("quote.transport"), t("quote.transportHint", { days: quote.logistics.transitDays }), quote.transport || 0, cell)
    : "";
  return `<div class="quote">
    <p class="kicker">${t("quote.kicker")}</p>
    <div class="bill-total">
      <span>${t("quote.total")}<small>${t("quote.totalHint")}</small></span>
      <b>${money(quote.charged, cell)}</b>
    </div>
    <h3>${t("quote.breakdown")}</h3>
    <div class="bill">
      ${billRow(t("quote.rental"), t("quote.rentalHint"), quote.rental, cell)}
      ${billRow(t("quote.fee"), t("quote.feeHint"), quote.serviceFee, cell)}
      ${billRow(t("quote.protection"), t("quote.protectionHint"), quote.protection, cell)}
      ${transport}
    </div>
    <div class="commission">
      <h3>${t("quote.commission")}</h3>
      <p>${t("quote.commissionP", { amount: money(quote.rental, cell) })}</p>
      <div class="bill">
        ${billRow(t("quote.ownerGets"), null, quote.ownerPayout, cell)}
        ${billRow(t("quote.platformFee"), null, quote.ownerCommission, cell)}
      </div>
    </div>
    <div class="aside-pay">
      <h3>${t("quote.deposit")}</h3>
      ${billRow(t("quote.guarantee"), t("quote.depositHint"), quote.deposit, cell)}
    </div>
    ${quote.logistics ? `<p class="muted">${t("quote.dispatch", { dispatch: esc(quote.logistics.dispatchDate), back: esc(quote.logistics.returnBy), mode: esc(quote.logistics.mode) })}</p>` : `<p class="muted">${t("quote.freightNote")}</p>`}
  </div>`;
}

function exploreForm(q, country, category, includeUnverified) {
  const categories = ["Excavación", "Elevación", "Carga", "Compactación", "Concreto", "Grúa"];
  return `<form class="panel" data-form="search">
      <div class="grid">
        <label>${t("explore.q")}<input name="q" value="${esc(q)}" placeholder="Excavadora, grúa, nacelle, Bagger"></label>
        <label>${t("explore.country")}<select name="country"><option value="">${t("explore.allCountries")}</option>${brief.countries.map((item) => `<option value="${item.code}" ${item.code === country ? "selected" : ""}>${esc(countryName(item.code))}</option>`).join("")}</select></label>
        <label>${t("explore.category")}<select name="category"><option value="">${t("explore.allCategories")}</option>${categories.map((item) => `<option value="${esc(item)}" ${item === category ? "selected" : ""}>${esc(categoryName(item))}</option>`).join("")}</select></label>
      </div>
      <label class="check"><input type="checkbox" name="includeUnverified" ${includeUnverified ? "checked" : ""}> ${t("explore.unverified")}</label>
      <button>${q || country || category ? t("explore.filter") : t("explore.submit")}</button>
    </form>`;
}

async function viewHome() {
  const result = await searchCatalog();
  const suggestions = marketplace(result.machines).slice(0, 9);
  const home = preferredCell();
  return `<section class="hero">
    <div>
      <p class="kicker">${t("home.kicker")}</p>
      <h1>${t("home.title")}</h1>
      <p class="lede">${t("home.lede")}</p>
    </div>
    ${exploreForm("", "", "", false)}
  </section>
  <section class="grid countries">${brief.countries.map((country) => `<article class="card"><p class="kicker">${FLAGS[country.code]} ${esc(country.language)}</p><h3>${esc(countryName(country.code))}</h3><p>${esc(country.subsidiary)}</p><p class="muted">${esc(country.provider)} · ${esc(country.invoiceSystem)} · ${esc(country.taxAuthority)}</p></article>`).join("")}</section>
  <section class="section grid">
    <article class="card"><h3>${t("home.step1")}</h3><p>${t("home.step1p")}</p></article>
    <article class="card"><h3>${t("home.step2")}</h3><p>${t("home.step2p")}</p></article>
    <article class="card"><h3>${t("home.step3")}</h3><p>${t("home.step3p")}</p></article>
  </section>
  <section class="section">
    <div class="bar"><h2>${t("home.suggestions")}</h2><a class="button secondary" href="#/explorar">${t("home.seeAll")}</a></div>
    <p class="muted">${session || localStorage.getItem("maquirent.lang") ? t("home.localNote", { country: countryName(home) }) : t("home.guestNote")}</p>
    <div class="grid">${suggestions.map(machineCard).join("") || `<p>${t("explore.empty")}</p>`}</div>
  </section>`;
}

async function viewExplore(params) {
  const q = params.get("q") || "";
  const country = params.get("country") || "";
  const category = params.get("category") || "";
  const includeUnverified = params.get("includeUnverified") === "1";
  const query = new URLSearchParams();
  if (q) query.set("q", q);
  if (country) query.set("country", country);
  if (category) query.set("category", category);
  if (includeUnverified) query.set("includeUnverified", "1");
  const result = await searchCatalog(query);
  const machines = marketplace(result.machines);
  const filtered = Boolean(q || country || category);
  return `<section class="section">
    <p class="kicker">${t("explore.kicker")}</p>
    <h1>${filtered ? t("explore.results") : t("explore.title")}</h1>
    <p class="lede">${filtered ? t("explore.ledeFilter") : t("explore.lede")}</p>
    ${exploreForm(q, country, category, includeUnverified)}
    <p class="muted">${t("explore.count", { n: machines.length })}${session ? t("explore.withoutMine") : ""}. ${t("explore.hint")}</p>
    <div class="grid">${machines.map(machineCard).join("") || `<p>${t("explore.empty")}</p>`}</div>
  </section>`;
}

async function viewMachine(cell, id) {
  const globalResult = await api(`/api/global/machines/${cell}/${id}`).catch((error) => ({ error }));
  const cellResult = await api(`/api/cells/${cell}/machines/${id}`).catch((error) => ({ error }));
  const machine = cellResult.machine || globalResult.machine;
  if (!machine) return `<h1>${t("machine.unavailable")}</h1><p>${esc(globalResult.error?.message || cellResult.error?.message || "")}</p>`;
  const globalBlocks = JSON.stringify(globalResult.machine?.blocks || []);
  const cellBlocks = JSON.stringify(cellResult.machine?.blocks || []);
  const diverged = globalResult.machine && cellResult.machine && globalBlocks !== cellBlocks;
  const info = countryOf(cell);
  const logistics = await api(`/api/cells/${cell}/logistics?homeCell=${session?.cell || cell}`).catch(() => null);
  const trip = logistics ? (logistics.sameCountry
    ? t("machine.localTrip", { origin: logistics.originName, days: logistics.transitDays, start: logistics.earliestStart, freight: money(logistics.transport, cell) })
    : t("machine.crossTrip", { dest: logistics.destinationName, origin: logistics.originName, days: logistics.transitDays, mode: logistics.mode, start: logistics.earliestStart, freight: money(logistics.transport, cell) }))
    : t("machine.needAccount");
  const minStart = minDelivery(logistics);
  return `<section class="section grid two">
    <div>
      ${(() => {
        const shots = machinePhotos({ ...machine, cell, id, machineId: id }, cell);
        if (!shots.length) return "";
        if (shots.length === 1) return `<img class="shot-lg" src="${shots[0]}" alt="">`;
        return `<div class="photo-gallery">${shots.map((url) => `<img class="shot" src="${url}" alt="">`).join("")}</div>`;
      })()}
      <p class="kicker">${FLAGS[cell]} ${esc(countryName(cell))} · ${esc(info.language)} · ${t("machine.contractHere")}</p>
      <h1>${esc(machine.title || globalResult.machine.title)}</h1>
      <p class="lede">${esc(machine.description || "")}</p>
      <p>${esc(machine.city)} · ${esc(machine.brand)} ${esc(machine.model)} · ${esc(machine.year)} · ${t("machine.hours")} ${esc(machine.hourMeter)}</p>
      <p class="price">${money(machine.dailyRate, cell)} <span class="muted">${t("card.day")}</span></p>
      <div class="badges">
        <span class="badge">${machine.ownershipVerified || machine.ownershipStatus === "verified" ? t("card.verified") : t("card.pending")}</span>
        <span class="badge">${machine.operatorRequired ? t("machine.opYes") : t("machine.opNo")}</span>
        <span class="badge">${t("machine.pseudo")} ${esc(machine.ownerPseudonym || "")}</span>
        ${machine.tradeName ? `<span class="badge">${t("machine.trade")}: ${esc(machine.tradeName)}</span>` : ""}
      </div>
      ${diverged ? `<div class="callout">El índice global y la celda no muestran las mismas fechas. La búsqueda va detrás; la reserva usa la celda.</div>` : `<div class="callout good">Índice y celda coinciden en las fechas ocupadas que ya se replicaron.</div>`}
      ${cellResult.error ? `<div class="callout bad">La celda de ${esc(info.name)} no entregó la ficha: ${esc(cellResult.error.message)}. El anuncio del índice puede seguir visible.</div>` : ""}
      <h3>${t("machine.blocksIndex")}</h3>
      ${blockList(globalResult.machine?.blocks)}
      <h3>${t("machine.blocksCell")}</h3>
      ${cellResult.machine ? blockList(cellResult.machine.blocks) : `<p class="muted">La celda no respondió.</p>`}
    </div>
    ${isMine(machine) ? `<aside class="panel">
      <p class="kicker">${t("machine.yours")}</p>
      <h3>${money(machine.dailyRate, cell)} ${t("card.day")}</h3>
      <div class="callout">${t("machine.yoursNote")}</div>
      <p class="muted">${t("machine.noSelf")}</p>
      <a class="button" href="#/maquinas">${t("machine.goMine")}</a>
    </aside>` : `<form class="panel" data-form="book" data-cell="${cell}" data-machine="${id}" data-min-start="${esc(minStart)}">
      <p class="kicker">${t("machine.book")}</p>
      <h3>${money(machine.dailyRate, cell)} ${t("card.day")}</h3>
      <div class="callout">${trip}</div>
      <p class="muted">${t("machine.intermediary")}</p>
      <label>${t("machine.start")}<input type="date" name="startDate" required min="${esc(minStart)}"></label>
      <label>${t("machine.end")}<input type="date" name="endDate" required min="${esc(nextDay(minStart))}"></label>
      <button type="button" data-action="preview-quote">${t("machine.preview")}</button>
      <div id="quote-box"></div>
      ${session ? `<button>${t("machine.request")}</button>` : `<a class="button" href="#/entrar">${t("machine.loginToBook")}</a>`}
    </form>`}
  </section>`;
}

function blockList(blocks = []) {
  if (!blocks.length) return `<p class="muted">${t("machine.noBlocks")}</p>`;
  return `<ul>${blocks.map((block) => `<li>${esc(block.startDate)} → ${esc(block.endDate)} · ${esc(brief.states[block.state] || block.state)}</li>`).join("")}</ul>`;
}

function viewLogin() {
  const recovering = location.hash.includes("recuperar");
  const groups = brief.countries.map((country) => {
    const accounts = demo.accounts.filter((account) => account.cell === country.code);
    return `<div class="demo-country"><h3>${FLAGS[country.code]} ${esc(countryName(country.code))}</h3>${accounts.map((account) => `<button class="account" type="button" data-action="demo-login" data-cell="${account.cell}" data-email="${esc(account.email)}"><strong>${esc(account.legalName)}</strong><br><span class="muted">${esc(accountRole(account.role))}${account.kycStatus === "pending" ? " · empieza en revisión" : ""} · ${esc(account.email)}</span></button>`).join("")}</div>`;
  }).join("");
  return `<section class="login-layout">
    <div class="login-pair">
      <form class="panel" data-form="login" ${recovering ? "hidden" : ""}>
        <p class="kicker">${t("login.kicker")}</p>
        <h1>${t("login.title")}</h1>
        <p>${t("login.p")}</p>
        <label>${t("login.cell")}<select name="cell">${brief.countries.map((country) => `<option value="${country.code}">${esc(countryName(country.code))}</option>`).join("")}</select></label>
        <label>${t("login.email")}<input name="email" type="email" autocomplete="username" required></label>
        <label>${t("login.password")}<input name="password" type="password" autocomplete="current-password" required></label>
        <button>${t("login.submit")}</button>
        <p class="switch"><a href="#/entrar?recuperar=1">${t("login.forgot")}</a></p>
      </form>
      <form class="panel" data-form="forgot" ${recovering ? "" : "hidden"}>
        <h2>${t("login.recoverTitle")}</h2>
        <p class="muted">${t("login.recoverP")}</p>
        <label>${t("explore.country")}<select name="cell">${brief.countries.map((country) => `<option value="${country.code}">${esc(countryName(country.code))}</option>`).join("")}</select></label>
        <label>${t("login.email")}<input name="email" type="email" required></label>
        <button>${t("login.recoverSubmit")}</button>
        <p class="switch"><a href="#/entrar">${t("login.back")}</a></p>
      </form>
      <aside class="panel register-cta">
        <h2>${t("login.ctaTitle")}</h2>
        <p>${t("login.ctaP")}</p>
        <a class="button" href="#/registro">${t("login.ctaBtn")}</a>
      </aside>
    </div>
    <details class="demo">
      <summary>${t("login.demo")}</summary>
      <p class="muted">${t("login.demoP", { password: esc(demo.password) })}</p>
      <div class="demo-grid">${groups}</div>
    </details>
  </section>`;
}

function paperFields(paper) {
  return `<fieldset class="paper" data-paper="${paper.key}">
    <legend data-title>${esc(paper.title)}</legend>
    <p class="muted" data-detail>${esc(paper.detail)}</p>
    <label>Archivo PDF o foto<input type="file" name="file_${paper.key}" accept=".pdf,image/*" required></label>
    ${paper.needsReference ? `<label>Número del certificado<input name="ref_${paper.key}" required minlength="4" autocomplete="off"></label>` : ""}
    ${paper.needsPolicy ? `<div class="grid">
      <label>Aseguradora<input name="insurer" required autocomplete="organization"></label>
      <label>Número de póliza<input name="ref_${paper.key}" required minlength="4" autocomplete="off"></label>
      <label>Vigente hasta<input name="expires" type="date" required></label>
    </div>` : ""}
  </fieldset>`;
}

function viewRegister() {
  const pack = brief.onboarding.CO;
  return `<section class="auth-wide">
    <p class="kicker">Alta de empresa</p>
    <h1>Registra la empresa</h1>
    <p>Los datos se guardan en el país que elijas. Para alquilar hace falta el expediente completo: la filial lo revisa antes de dejar reservar.</p>
    <form class="panel" data-form="register">
      <h2>1. La empresa</h2>
      <label>País de la empresa<select name="cell">${brief.countries.map((country) => `<option value="${country.code}">${esc(country.name)}</option>`).join("")}</select></label>
      <div class="grid">
        <label>Razón social<input name="legalName" required minlength="3" autocomplete="organization"></label>
        <label>Nombre comercial<input name="tradeName" autocomplete="organization"></label>
        <label>Tipo de sociedad<select name="legalForm">${pack.legalForms.map((item) => `<option>${esc(item)}</option>`).join("")}</select></label>
      </div>
      <div class="grid">
        <label><span data-tax-label>${esc(pack.taxLabel)}</span><input name="taxId" required minlength="5" placeholder="${esc(pack.taxPlaceholder)}" autocomplete="off"></label>
        <label>Ciudad<input name="city" required autocomplete="address-level2"></label>
        <label>Teléfono<input name="phone" type="tel" required autocomplete="tel"></label>
      </div>
      <label>Dirección de la empresa<input name="address" required autocomplete="street-address"></label>
      <label>Correo de la empresa<input name="email" type="email" required autocomplete="email"></label>
      <div class="grid">
        <label>Contraseña<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
        <label>Confirmar contraseña<input name="password2" type="password" required minlength="8" autocomplete="new-password"></label>
      </div>
      <h2>2. Representante legal</h2>
      <div class="grid">
        <label>Nombre completo<input name="representativeName" required minlength="5" autocomplete="name"></label>
        <label>Número de documento<input name="representativeId" required minlength="5" autocomplete="off"></label>
      </div>
      <h2>3. Papeles para alquilar</h2>
      <p class="muted">Cada archivo queda en el expediente de esta celda. El plano de búsqueda no recibe estos documentos.</p>
      ${pack.papers.map(paperFields).join("")}
      <label class="check"><input type="checkbox" name="acceptTerms" required> Acepto los términos, el aviso de privacidad y la política de cancelación. Declaro que los documentos son de esta empresa y que MaquiRent solo intermedia.</label>
      <button>Crear cuenta y enviar expediente</button>
      <p class="muted">¿Ya está registrada? <a href="#/entrar">Ingresar</a></p>
    </form>
  </section>`;
}

function applyRegisterPack(form, cell) {
  const pack = brief.onboarding[cell];
  if (!pack || !form) return;
  const legal = form.querySelector("[name=legalForm]");
  const selected = legal.value;
  legal.innerHTML = pack.legalForms.map((item) => `<option ${item === selected ? "selected" : ""}>${esc(item)}</option>`).join("");
  form.querySelector("[data-tax-label]").textContent = pack.taxLabel;
  form.querySelector("[name=taxId]").placeholder = pack.taxPlaceholder;
  for (const paper of pack.papers) {
    const box = form.querySelector(`[data-paper="${paper.key}"]`);
    if (!box) continue;
    box.querySelector("[data-title]").textContent = paper.title;
    box.querySelector("[data-detail]").textContent = paper.detail;
  }
}

function accountRole(role) {
  return { admin: "Filial", owner: "Publica", renter: "Alquila" }[role] || role;
}

function kycLabel(status) {
  return { pending: "En revisión de la filial", verified: "Aprobada por la filial", rejected: "Rechazada por la filial" }[status] || status;
}

function operatorLabel(status) {
  return { none: "Sin certificado", pending: "En revisión de la filial", verified: "Aprobado", rejected: "Rechazado" }[status] || status;
}

function ownershipLabel(status) {
  return { pending: "En revisión de la filial", verified: "Aprobada", rejected: "Rechazada" }[status] || status;
}

function dossierPanel(user, info) {
  const papers = user.dossier?.papers ? Object.values(user.dossier.papers) : [];
  const headline = {
    pending: "En revisión. La filial de este país debe aprobar los papeles antes de reservar o publicar.",
    verified: "Aprobado. Esta empresa ya puede reservar y publicar.",
    rejected: "Rechazado. La filial no habilitó esta empresa.",
  }[user.kycStatus] || "Falta el expediente de la empresa.";
  const reason = user.kycStatus === "rejected" && user.kycNote ? `<div class="callout bad"><strong>Motivo.</strong> ${esc(user.kycNote)}</div>` : "";
  const operatorReason = user.operatorStatus === "rejected" && user.operatorNote && user.kycStatus !== "rejected"
    ? `<div class="callout bad"><strong>Operador.</strong> ${esc(user.operatorNote)}</div>`
    : "";
  const resubmit = user.kycStatus === "rejected" || user.operatorStatus === "rejected"
    ? `<form data-form="resubmit-dossier"><p class="muted">Corrige lo que indicó la filial y vuelve a enviarlo. Seguirá sin poder reservar hasta una nueva aprobación.</p><button>Enviar de nuevo a revisión</button></form>`
    : "";
  return `<article class="card">
    <h3>Expediente para alquilar</h3>
    <p>${headline}</p>
    ${user.dossier?.legalForm ? `<p>${esc(user.dossier.legalForm)}${user.dossier.representativeName ? ` · representante ${esc(user.dossier.representativeName)}` : ""}</p>` : ""}
    ${papers.length ? `<ul class="paper-list">${Object.entries(user.dossier.papers).map(([key, paper]) => paperRow(paper, { userId: user.id, paperKey: key, self: true })).join("")}</ul>` : `<p class="muted">${esc(info.safetyNote)}</p>`}
    ${reason}${operatorReason}${resubmit}
  </article>`;
}

function reviewForm(kind, id) {
  return `<form data-form="admin-review" data-kind="${esc(kind)}" data-id="${esc(id)}">
    <label>Motivo, obligatorio si rechazas<textarea name="note" placeholder="Qué papel falta o qué no coincide"></textarea></label>
    <div class="actions">
      <button value="approved">Aprobar</button>
      <button class="danger" value="rejected">Rechazar</button>
    </div>
  </form>`;
}

function machineMine(machine) {
  const shots = machinePhotos({ ...machine, cell: session.cell }, session.cell);
  return `<article class="card">
    ${shots[0] ? `<img class="shot" src="${shots[0]}" alt="">` : ""}
    <h3><a href="#/maquina/${session.cell}/${machine.id}">${esc(machine.title)}</a></h3>
    <p>${money(machine.dailyRate, session.cell)} ${t("card.day")} · ${esc(machine.city)}</p>
    <p>${t("mine.ownership")}: <strong>${esc(ownershipLabel(machine.ownershipStatus))}</strong>${machine.ownershipDoc ? ` · ${esc(machine.ownershipDoc)}` : ""}</p>
    ${machine.ownershipStatus === "verified" ? `<p class="muted">${t("mine.visible")}</p>` : `<p>${machine.ownershipStatus === "rejected" ? "La filial rechazó la publicación. Corrige factura o fotos y envíala otra vez." : "La filial revisa fotos y factura antes de publicar y dejar reservar esta máquina."}</p>`}
    ${machine.ownershipStatus === "rejected" ? `<form data-form="submit-ownership" data-id="${machine.id}"><div class="callout bad">${esc(machine.ownershipNote || "Sin motivo registrado.")}</div><label>Factura o registro corregido<input name="ownershipDoc" value="${esc(machine.ownershipDoc || "")}" required minlength="4"></label><label>Fotos nuevas (opcional, hasta 4)<input name="photos" type="file" accept="image/*" multiple></label><button>Enviar otra vez a la filial</button></form>` : ""}
  </article>`;
}

async function viewAccount() {
  const user = await api(`/api/cells/${session.cell}/me`);
  session.user = user;
  saveSession(session);
  const info = countryOf(user.cell);
  if (user.role === "admin") {
    return `<section class="section">
      <p class="kicker">${FLAGS[user.cell]} ${esc(countryName(user.cell))}</p>
      <h1>${esc(user.legalName)}</h1>
      <p>Esta cuenta es la filial de ${esc(countryName(user.cell))}. Aprueba o rechaza expedientes de empresas y publicaciones de máquinas (fotos y factura). No publica ni alquila.</p>
      <p class="actions-inline"><a class="button" href="#/revision">Abrir la cola de revisión</a></p>
    </section>`;
  }
  const result = await api(`/api/cells/${session.cell}/machines`);
  const mine = result.machines.filter((machine) => machine.ownerPseudonym === user.pseudonym);
  const intro = user.kycStatus === "verified"
    ? t("account.both")
    : "Hasta que la filial apruebe el expediente, esta cuenta no puede reservar ni publicar.";
  return `<section class="section grid two">
    <div>
      <p class="kicker">${FLAGS[user.cell]} ${esc(countryName(user.cell))}</p>
      <h1>${esc(user.legalName)}</h1>
      <p>${t("account.pseudo")} ${esc(user.pseudonym)}. ${intro}</p>
      <div class="callout">MaquiRent es el intermediario. El propietario es quien publica la máquina y el arrendatario es la empresa que la usa. Nosotros no somos ninguna de las dos partes ni custodiamos el dinero.</div>
      <div class="card">
        <p>Correo ${esc(user.email)}</p>
        <p>${esc(brief.onboarding[user.cell]?.taxLabel || info.taxIdLabel)} ${esc(user.taxId)}</p>
        <p>${esc(user.phone)} · ${esc(user.address)}, ${esc(user.city)}</p>
        <p>Empresa: <strong>${esc(kycLabel(user.kycStatus))}</strong>${user.kycDoc ? ` · ${esc(user.kycDoc)}` : ""}</p>
        <p>Operador: <strong>${esc(operatorLabel(user.operatorStatus))}</strong>${user.operatorCertificate ? ` · ${esc(user.operatorCertificate)}` : ""}</p>
      </div>
      <p class="muted">${esc(info.privacyNote)}</p>
    </div>
    <div>${dossierPanel(user, info)}</div>
  </section>
  <section class="section">
    <article class="card">
      <h2>${t("account.pubTitle")}</h2>
      <p>${user.kycStatus === "verified" ? (mine.length ? t("account.pubCount", { n: mine.length }) : t("account.pubEmpty")) : "Publicar se habilita cuando la filial apruebe el expediente."}</p>
      ${user.kycStatus === "verified" ? `<p class="actions-inline"><a class="button" href="#/maquinas">${t("account.openMine")}</a><a class="button secondary" href="#/publicar">${t("nav.publish")}</a></p>` : ""}
    </article>
  </section>`;
}

async function viewPublish() {
  const user = await api(`/api/cells/${session.cell}/me`);
  session.user = user;
  saveSession(session);
  if (user.kycStatus !== "verified") {
    return `<section class="section" style="max-width:760px"><h1>Falta la aprobación de la filial</h1><p>${esc(kycLabel(user.kycStatus))}. Cuando el expediente esté aprobado podrás publicar.</p><p><a href="#/cuenta">Ver el expediente</a></p></section>`;
  }
  const info = countryOf(session.cell);
  return `<section class="section" style="max-width:760px">
    <h1>${t("publish.title", { country: countryName(session.cell) })}</h1>
    <p>Cualquier cuenta aprobada puede publicar, también si la abriste para alquilar. La tarifa se escribe en ${esc(info.currency)} y al lado se muestra el equivalente en dólares. Sube fotos del equipo: serán las que vea quien explore. La máquina no aparece como reservable hasta que la filial apruebe la publicación (fotos y factura o registro).</p>
    <form class="panel" data-form="publish">
      <label>Título<input name="title" required></label>
      <label>${t("explore.category")}<select name="category">${["Excavación", "Elevación", "Carga", "Compactación", "Concreto", "Grúa"].map((item) => `<option value="${esc(item)}">${esc(categoryName(item))}</option>`).join("")}</select></label>
      <div class="grid">
        <label>Marca<input name="brand" required></label>
        <label>Modelo<input name="model" required></label>
        <label>Año<input name="year" type="number" required></label>
      </div>
      <div class="grid">
        <label>Horómetro<input name="hourMeter" type="number" required></label>
        <label>Tarifa diaria (${esc(info.currency)})<input name="dailyRate" type="number" min="1" step="0.01" required></label>
        <label>Ciudad<input name="city" required></label>
      </div>
      <label>Descripción pública<textarea name="description" required></textarea></label>
      <label>Fotos de la máquina (1 a 4)<input name="photos" type="file" accept="image/*" multiple required><span class="muted">JPG, PNG o WebP. Cada una menos de 350 KB. La primera es la portada del anuncio.</span></label>
      <label>Factura o registro del equipo<input name="ownershipDoc" placeholder="FAC-2026-100" required minlength="4"></label>
      <label class="check"><input type="checkbox" name="operatorRequired" checked> Exigir operador certificado</label>
      <button>Enviar a la filial</button>
    </form>
  </section>`;
}

function paperRow(paper, opts) {
  const meta = `${esc(paper.file)}${paper.reference ? ` · ${esc(paper.reference)}` : ""}${paper.insurer ? ` · ${esc(paper.insurer)} hasta ${esc(paper.expires)}` : ""}`;
  const action = opts.self
    ? `data-action="view-paper" data-self="1" data-key="${esc(opts.paperKey)}"`
    : `data-action="view-paper" data-user="${esc(opts.userId)}" data-key="${esc(opts.paperKey)}"`;
  return `<li class="paper-item"><div><strong>${esc(paper.title)}</strong><br><span class="muted">${meta}</span></div><button type="button" class="secondary" ${action}>Ver</button></li>`;
}

function paperList(user) {
  const papers = user.dossier?.papers ? Object.entries(user.dossier.papers) : [];
  if (!papers.length) return "<p class=\"muted\">Esta cuenta no guardó el detalle de los papeles.</p>";
  return `<ul class="paper-list">${papers.map(([key, paper]) => paperRow(paper, { userId: user.id, paperKey: key })).join("")}</ul>`;
}

function closePaperViewer() {
  document.getElementById("paper-viewer")?.remove();
  if (closePaperViewer.url) {
    URL.revokeObjectURL(closePaperViewer.url);
    closePaperViewer.url = null;
  }
}

async function openPaperViewer(doc) {
  closePaperViewer();
  const binary = atob(doc.content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: doc.mime || "application/pdf" });
  const url = URL.createObjectURL(blob);
  closePaperViewer.url = url;
  const isImage = String(doc.mime || "").startsWith("image/");
  const viewer = document.createElement("div");
  viewer.id = "paper-viewer";
  viewer.innerHTML = `<div class="paper-viewer-panel">
    <div class="bar">
      <div><p class="kicker">Documento</p><h2>${esc(doc.title || doc.file || "Papel")}</h2><p class="muted">${esc(doc.file || "")}${doc.generated ? " · vista de revisión" : ""}</p></div>
      <div class="actions">
        <a class="button secondary" href="${url}" download="${esc(doc.file || "documento.pdf")}" target="_blank" rel="noopener">Abrir en pestaña</a>
        <button type="button" data-action="close-paper">Cerrar</button>
      </div>
    </div>
    ${isImage ? `<img class="paper-frame" src="${url}" alt="${esc(doc.title || "Documento")}">` : `<iframe class="paper-frame" title="${esc(doc.title || "Documento")}" src="${url}"></iframe>`}
  </div>`;
  document.body.appendChild(viewer);
}

async function readUpload(file) {
  if (!file) return null;
  if (file.size > 350_000) throw new Error(`«${file.name}» supera 350 KB. Usa un PDF o foto más liviano.`);
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return {
    file: file.name,
    mime: file.type || "application/pdf",
    content: btoa(binary),
  };
}

async function viewReview() {
  const queue = await api(`/api/cells/${session.cell}/admin/queue`);
  const empty = !queue.dossiers.length && !queue.operators.length && !queue.machines.length;
  const dossiers = queue.dossiers.map((user) => `<article class="card">
    <p class="kicker">${esc(accountRole(user.role))} · ${esc(kycLabel(user.kycStatus))}</p>
    <h3>${esc(user.legalName)}</h3>
    <p>${esc(user.email)} · ${esc(user.taxId)} · ${esc(user.city)}</p>
    ${user.dossier?.representativeName ? `<p>Representante ${esc(user.dossier.representativeName)} · ${esc(user.dossier.representativeId || "")}</p>` : ""}
    ${paperList(user)}
    ${reviewForm("dossier", user.id)}
  </article>`).join("");
  const operators = queue.operators.map((user) => `<article class="card">
    <p class="kicker">Operador · ${esc(operatorLabel(user.operatorStatus))}</p>
    <h3>${esc(user.legalName)}</h3>
    <p>${esc(user.email)}</p>
    <p>Certificado <strong>${esc(user.operatorCertificate || "")}</strong></p>
    ${reviewForm("operator", user.id)}
  </article>`).join("");
  const machines = queue.machines.map((machine) => {
    const shots = machinePhotos({ ...machine, cell: session.cell }, session.cell);
    return `<article class="card">
    <p class="kicker">Publicación de máquina · ${esc(ownershipLabel(machine.ownershipStatus))}</p>
    <h3>${esc(machine.title)}</h3>
    <p>${esc(machine.tradeName || "")}${machine.ownerEmail ? ` · ${esc(machine.ownerEmail)}` : ""} · ${esc(machine.city)}</p>
    ${shots.length ? `<div class="photo-thumbs">${shots.map((url) => `<img src="${url}" alt="">`).join("")}</div>` : `<p class="muted">Sin fotos adjuntas.</p>`}
    <p>Referencia <strong>${esc(machine.ownershipDoc || "")}</strong></p>
    <p class="actions-inline"><button type="button" class="secondary" data-action="view-ownership" data-id="${esc(machine.id)}">Ver factura</button></p>
    ${reviewForm("ownership", machine.id)}
  </article>`;
  }).join("");
  return `<section class="section">
    <p class="kicker">${FLAGS[session.cell]} Filial de ${esc(countryName(session.cell))}</p>
    <h1>Revisión de papeles</h1>
    <p>Solo esta cuenta decide. Una empresa no puede aprobarse sola. Rechazar exige un motivo, y la empresa lo ve en su cuenta.</p>
    ${empty ? `<div class="callout">No hay expedientes ni publicaciones pendientes en este país.</div>` : ""}
    ${dossiers ? `<h2 class="section">Empresas</h2><div class="review-list">${dossiers}</div>` : ""}
    ${operators ? `<h2 class="section">Certificados de operador</h2><div class="review-list">${operators}</div>` : ""}
    ${machines ? `<h2 class="section">Máquinas por publicar</h2><div class="review-list">${machines}</div>` : ""}
  </section>`;
}

async function viewOwnerMachines() {
  const result = await api(`/api/cells/${session.cell}/machines`);
  const mine = result.machines.filter((machine) => machine.ownerPseudonym === session.user.pseudonym);
  return `<section class="section">
    <div class="bar"><h1>${t("mine.title")}</h1><a class="button" href="#/publicar">${t("mine.another")}</a></div>
    <p class="lede">${t("mine.lede")}</p>
    <div class="grid">${mine.map(machineMine).join("") || `<p>${t("mine.empty")} <a href="#/publicar">${t("mine.first")}</a>.</p>`}</div>
  </section>`;
}

function bookingCardMeta(booking) {
  const days = booking.schedule?.rentalDays || booking.quote?.days || "—";
  if (booking.schedule?.clockRunning) {
    return booking.schedule.overdue
      ? `Uso vencido · debía devolverse ${formatWhen(booking.schedule.dueReturnAt)}`
      : `En uso · quedan ${formatSpan(booking.schedule.remainingMs)} · ${days} día(s) contratados`;
  }
  return `${esc(booking.startDate)} → ${esc(booking.endDate)} · ${days} día(s) en obra`;
}

async function viewBookings() {
  const result = await api(`/api/my/bookings?homeCell=${session.cell}`);
  return `<section class="section"><h1>${t("bookings.title")}</h1><p class="muted">${t("bookings.lede")}</p><div class="grid">${result.bookings.map((booking) => `<a class="card" href="#/alquiler/${booking.cell}/${booking.id}"><p class="kicker">${FLAGS[booking.cell]} ${esc(booking.stateLabel)} · ${booking.side === "owner" ? t("bookings.owner") : t("bookings.renter")}</p><h3>${esc(booking.machine.title)}</h3><p>${bookingCardMeta(booking)}</p><p>${money(booking.quote.charged, booking.cell)}</p></a>`).join("") || `<p>${t("bookings.empty")}</p>`}</div></section>`;
}

function renderScheduleBoard(booking) {
  const schedule = booking.schedule;
  if (!schedule) return "";
  const clockClass = schedule.overdue ? "clock-card late" : schedule.clockRunning ? "clock-card live" : "clock-card";
  const clockBody = schedule.returnedAt
    ? `<p class="clock-value">${formatSpan(schedule.usedMs)}</p><p class="muted">Tiempo real de uso, desde la entrega hasta la devolución.</p>`
    : schedule.clockRunning
      ? `<p class="clock-value" data-clock-remaining>${formatSpan(schedule.remainingMs)}</p>
         <p>Debes devolverla antes del <strong>${esc(formatWhen(schedule.dueReturnAt))}</strong>.</p>
         <p class="muted">Llevas <span data-clock-used>${formatSpan(schedule.usedMs)}</span> de uso.</p>`
      : `<p class="clock-value">${esc(schedule.rentalDays)} día(s)</p><p class="muted">${esc(schedule.note)}</p>`;
  return `<div class="schedule-board section">
    <article class="${clockClass}">
      <p class="kicker">${schedule.overdue ? "Fuera de plazo" : schedule.clockRunning ? "Conteo en curso" : schedule.returnedAt ? "Uso cerrado" : "Duración contratada"}</p>
      <h3>${schedule.clockRunning || schedule.returnedAt ? "Tiempo de la máquina" : "Cuánto tiempo la tienes"}</h3>
      ${clockBody}
    </article>
    <div class="schedule-grid">
      ${schedule.dispatchDate ? `<article class="card"><p class="kicker">Transporte</p><h3>Sale el ${esc(formatWhen(schedule.dispatchDate))}</h3><p class="muted">${schedule.transitDays != null ? `${esc(schedule.transitDays)} días · ${esc(schedule.mode || "")}` : esc(schedule.mode || "")}</p></article>` : ""}
      <article class="card"><p class="kicker">Entrega en obra</p><h3>${esc(formatWhen(schedule.plannedDelivery))}</h3><p class="muted">${schedule.deliveredAt ? `Registrada ${esc(formatWhen(schedule.deliveredAt))}` : "Todavía no hay acta de entrega."}</p></article>
      <article class="card"><p class="kicker">Devolución</p><h3>${esc(formatWhen(schedule.dueReturnAt || schedule.plannedReturn))}</h3><p class="muted">${schedule.returnedAt ? `Registrada ${esc(formatWhen(schedule.returnedAt))}` : schedule.clockRunning ? "Cuenta desde el acta de entrega." : `Prevista el ${esc(formatWhen(schedule.plannedReturn))}.`}</p></article>
      ${schedule.freeAgain ? `<article class="card"><p class="kicker">Libera el equipo</p><h3>${esc(formatWhen(schedule.freeAgain))}</h3><p class="muted">Fecha en que la máquina vuelve a estar libre, viaje incluido.</p></article>` : ""}
    </div>
  </div>`;
}

function renderTimeline(booking) {
  const timeline = booking.timeline;
  if (!timeline) return stepper(booking.state);
  const next = timeline.nextDeadline
    ? `<div class="callout ${booking.schedule?.overdue ? "bad" : "good"}"><strong>Ahora:</strong> ${esc(timeline.nextDeadline.label)}${timeline.nextDeadline.at ? ` · ${esc(formatWhen(timeline.nextDeadline.at))}` : ""}</div>`
    : "";
  return `<section class="timeline-board section">
    <div class="bar"><h2>${esc(timeline.title)}</h2><p class="muted">${esc(brief.principles.escrowTiming)}</p></div>
    ${next}
    <ol class="timeline">
      ${timeline.items.map((item) => `<li class="timeline-item ${esc(item.status)}">
        <span class="dot" aria-hidden="true"></span>
        <div>
          <p class="kicker">${item.status === "done" ? "Hecho" : item.status === "now" ? "Ahora" : item.status === "late" ? "Vencido" : item.status === "skipped" ? "No aplica" : "Siguiente"}</p>
          <h3>${esc(item.label)}</h3>
          <p>${esc(item.hint || "")}</p>
          <p class="muted">${item.at ? esc(formatWhen(item.at)) : "Sin registrar todavía"}</p>
        </div>
      </li>`).join("")}
    </ol>
  </section>`;
}

function startRentalClock(booking) {
  stopRentalClock();
  if (!booking.schedule?.clockRunning || !booking.schedule.dueReturnAt || !booking.schedule.deliveredAt) return;
  const due = new Date(booking.schedule.dueReturnAt).getTime();
  const started = new Date(booking.schedule.deliveredAt).getTime();
  const tick = () => {
    const now = Date.now();
    const remaining = document.querySelector("[data-clock-remaining]");
    const used = document.querySelector("[data-clock-used]");
    const card = document.querySelector(".clock-card");
    if (remaining) remaining.textContent = formatSpan(Math.max(0, due - now));
    if (used) used.textContent = formatSpan(Math.max(0, now - started));
    if (card && now > due) {
      card.classList.add("late");
      card.classList.remove("live");
      const kicker = card.querySelector(".kicker");
      if (kicker) kicker.textContent = "Fuera de plazo";
    }
  };
  tick();
  rentalClock = setInterval(tick, 1000);
}

async function viewBooking(cell, id) {
  const booking = await api(cellPath(cell, `/bookings/${id}`));
  const info = countryOf(cell);
  pendingRentalClock = booking;
  return `<section class="section">
    <p class="kicker">${FLAGS[cell]} ${esc(info.name)} · ${esc(booking.id)}</p>
    <h1>${esc(booking.machine.title)}</h1>
    <p>${esc(booking.parties.owner.legalName)} publica. ${esc(booking.parties.renter.legalName)} usa. MaquiRent solo intermedia.</p>
    ${renderScheduleBoard(booking)}
    ${renderTimeline(booking)}
    <div class="grid two">
      <div>
        ${economics(booking.quote)}
        <div class="action-stack section">${actionsFor(booking, cell)}</div>
      </div>
      <div>
        <article class="card"><h3>Papel de MaquiRent</h3><p>${esc(booking.intermediary)}</p><p class="muted">Foro si la mediación no basta: ${esc(booking.forum)}.</p><p><a href="#/contrato/${cell}/${booking.id}">Ver contrato modelo</a></p></article>
        <article class="card section"><h3>Actas</h3>${booking.acts.map(renderAct).join("") || "<p class='muted'>Todavía no hay acta.</p>"}</article>
        <article class="card section"><h3>Procesador, no custodia</h3>${booking.payments.map(renderPayment).join("") || "<p class='muted'>Aún no hay un cobro retenido.</p>"}</article>
        <article class="card section"><h3>Facturas de la celda</h3>${booking.invoices.map((invoice) => `<p><strong>${esc(invoice.number)}</strong> · ${esc(invoice.docType)} · ${esc(invoice.authority)}<br>${esc(invoice.issuerName)} → ${esc(invoice.recipientName)} · ${money(invoice.total, cell)}<br><span class="muted">${esc(invoice.taxName || invoice.taxNote)} estimado ${money(invoice.taxEstimate, cell)}</span></p>`).join("") || "<p class='muted'>Se emiten al liquidar o al aplicar una penalidad.</p>"}</article>
        ${booking.mediation?.length ? `<article class="card section"><h3>Mediación</h3>${booking.mediation.map((note) => `<p><strong>${esc(note.author)}</strong> · ${esc(note.text)}</p>`).join("")}</article>` : ""}
      </div>
    </div>
  </section>`;
}

function stepper(state) {
  if (state === "cancelled") return `<div class="callout">Cancelada. ${esc(brief.principles.escrowTiming)}</div>`;
  if (state === "disputed") return `<div class="callout bad">En disputa. Primero mediación de la celda; después, arbitraje o tribunales del país del contrato.</div>`;
  const index = FLOW.indexOf(state);
  return `<ol class="steps">${FLOW.map((item, position) => `<li class="${position < index ? "done" : ""} ${position === index ? "now" : ""}">${esc(brief.states[item])}</li>`).join("")}</ol><p class="muted">${esc(brief.principles.escrowTiming)}</p>`;
}

function actionPanel(kind, title, lede, body) {
  return `<article class="card action-panel action-${kind}">
    <p class="kicker">${kind === "next" ? "Siguiente paso" : kind === "exit" ? "Salida del alquiler" : "Conflicto"}</p>
    <h3>${title}</h3>
    ${lede ? `<p class="muted">${lede}</p>` : ""}
    ${body}
  </article>`;
}

function actionsFor(booking, cell) {
  if (booking.state === "requested") {
    const pay = actionPanel(
      "next",
      "Pagar y retener",
      esc(countryOf(cell).bankNote),
      `<form data-form="pay" data-id="${booking.id}" data-cell="${cell}">
        <label>Medio<select name="method"><option value="card">Tarjeta, vía ${esc(booking.quote.provider)}</option><option value="bank_transfer">Transferencia conciliada por ${esc(booking.quote.provider)}</option></select></label>
        <button>Cobrar y retener en el procesador</button>
      </form>`,
    );
    return `${pay}${cancelBox(booking, cell)}`;
  }
  if (booking.state === "paid_held") {
    return `${actForm("deliver", "Registrar acta de entrega", booking, cell)}${cancelBox(booking, cell)}${disputeForm(booking, cell)}`;
  }
  if (booking.state === "delivered") {
    return `${actForm("return", "Registrar acta de devolución", booking, cell)}${disputeForm(booking, cell)}`;
  }
  if (booking.state === "returned") {
    const settle = actionPanel(
      "next",
      "Liquidar",
      "El procesador puede repartir el cobro porque ya hay acta de devolución.",
      `<form data-form="settle" data-id="${booking.id}" data-cell="${cell}"><button>Liquidar y hacer el split</button></form>`,
    );
    return `${settle}${disputeForm(booking, cell)}`;
  }
  if (booking.state === "disputed") {
    return actionPanel(
      "conflict",
      "Mediación de la celda",
      `Si no hay acuerdo, el foro es ${esc(booking.forum)}.`,
      `<form data-form="mediate" data-id="${booking.id}" data-cell="${cell}"><label>Nota de mediación<textarea name="note" required></textarea></label><button>Añadir nota</button></form>
      <form class="section" data-form="resolve" data-id="${booking.id}" data-cell="${cell}"><label>Acuerdo<select name="outcome"><option value="release_owner">Liberar al propietario</option><option value="refund_renter">Reembolsar al arrendatario</option><option value="split">Partir el arrendamiento</option></select></label><button>Registrar acuerdo</button></form>`,
    );
  }
  return `<article class="card"><p>Este alquiler está en ${esc(booking.stateLabel)}. No hay un paso de dinero pendiente en la saga.</p></article>`;
}

function cancelBox(booking, cell) {
  if (!booking.cancellation) return "";
  return actionPanel(
    "exit",
    "Cancelar el alquiler",
    "Esto no entrega la máquina. Cierra la reserva según la política de fechas.",
    `<form data-form="cancel" data-id="${booking.id}" data-cell="${cell}">
      <div class="callout"><strong>${esc(booking.cancellation.title)}.</strong> ${esc(booking.cancellation.detail)}</div>
      <button class="secondary" type="submit">Aplicar cancelación</button>
    </form>`,
  );
}

function disputeForm(booking, cell) {
  return actionPanel(
    "conflict",
    "Abrir una disputa",
    "Úsalo si hay un desacuerdo. No sirve para entregar ni para cancelar con normalidad.",
    `<form data-form="dispute" data-id="${booking.id}" data-cell="${cell}">
      <label>Qué pasó<textarea name="note" required placeholder="Describe el conflicto"></textarea></label>
      <button class="danger" type="submit">Pasar a mediación</button>
    </form>`,
  );
}

function actForm(kind, title, booking, cell) {
  const checks = brief.checklist.map((label, index) => `<label class="check"><input type="checkbox" name="check${index}" checked> ${esc(label)}</label>`).join("");
  const days = booking.schedule?.rentalDays || booking.quote?.days || "—";
  const lede = kind === "deliver"
    ? `Al registrar esta acta empieza el conteo de los ${days} día(s) de uso. La devolución se calculará desde este momento.`
    : "Cierra el conteo de uso y deja lista la liquidación del cobro retenido.";
  return actionPanel(
    "next",
    title,
    lede,
    `<form data-form="${kind}" data-id="${booking.id}" data-cell="${cell}">
      <label>Horómetro<input name="hourMeter" type="number" required value="${esc(booking.machine.hourMeter)}"></label>
      <div class="grid"><label>Latitud<input name="lat" required value="${esc(booking.machine.lat)}"></label><label>Longitud<input name="lng" required value="${esc(booking.machine.lng)}"></label></div>
      <button type="button" class="secondary" data-action="geo">Usar mi ubicación</button>
      ${checks}
      <label>Fotos (archivos)<input name="photos" type="file" accept="image/*" multiple></label>
      <label>O nombres de foto, separados por coma<input name="photoNames" placeholder="frente.jpg, horometro.jpg"></label>
      ${kind === "return" ? `<label>Daño a descontar del depósito, en unidades mínimas<input name="damageClaim" type="number" value="0"></label>` : ""}
      <label>Notas<textarea name="notes"></textarea></label>
      <label class="check"><input type="checkbox" name="jointAcceptance" required> La contraparte está presente y acepta esta acta.</label>
      <button>${esc(title)}</button>
    </form>`,
  );
}

function renderAct(act) {
  const failed = act.checklist.filter((item) => !item.ok);
  return `<p><strong>${act.kind === "delivery" ? "Entrega" : "Devolución"}</strong> · horómetro ${esc(act.hourMeter)} · ${esc(act.lat)}, ${esc(act.lng)}<br>Fotos: ${esc(act.photos.join(", "))}<br>Hash ${esc(act.evidenceHash)}<br>${failed.length ? `Excepciones: ${esc(failed.map((item) => item.label).join(", "))}` : "Checklist completo."}</p>`;
}

function renderPayment(payment) {
  const split = payment.split ? Object.entries(payment.split).map(([key, value]) => `${esc(key)} ${esc(value)}`).join(" · ") : "";
  return `<p><strong>${esc(PAY_LABELS[payment.kind] || payment.kind)}</strong><br>${esc(payment.provider)} · ${esc(payment.method)} · ${esc(payment.reference)}<br>${split}</p>`;
}

async function viewContract(cell, id) {
  const contract = await api(cellPath(cell, `/bookings/${id}/contract`));
  return `<section class="section" style="max-width:800px"><p class="kicker">${esc(contract.country)} · ${esc(contract.language)}</p><h1>${esc(contract.title)}</h1><p>${esc(contract.subsidiary)} · procesador ${esc(contract.provider)} · foro ${esc(contract.forum)}</p>${contract.clauses.map((clause) => `<p>${esc(clause)}</p>`).join("")}</section>`;
}

async function viewTrust() {
  const emails = demo.accounts.map((account) => `<option value="${esc(account.email)}">${esc(account.legalName)} · ${esc(account.email)}</option>`).join("");
  return `<section class="section"><p class="kicker">Capa de confianza</p><h1>Quién responde, quién factura y dónde vive el dato</h1>
    <div class="table-wrap"><table><thead><tr><th>Riesgo</th><th>Mecanismo</th></tr></thead><tbody>${brief.guarantees.map((item) => `<tr><td>${esc(item.risk)}</td><td>${esc(item.mechanism)}</td></tr>`).join("")}</tbody></table></div>
    <div class="grid section">${[["Rol jurídico", brief.principles.role], ["Custodia", brief.principles.custody], ["Facturación", brief.principles.invoicing], ["Frontera", brief.principles.crossBorder]].map(([title, text]) => `<article class="card"><h3>${title}</h3><p>${esc(text)}</p></article>`).join("")}</div>
    <h2 class="section">Economía, más allá del 8%</h2>
    <form class="panel" data-form="economics" id="econ-form">
      <div class="grid">
        <label>País<select name="cell">${brief.countries.map((country) => `<option value="${country.code}">${esc(country.name)} · ${esc(country.provider)} ${pct(country.processorFeeRate)}</option>`).join("")}</select></label>
        <label>Tarifa diaria, en moneda local<input name="dailyRate" type="number" value="1850000" required></label>
        <label>Días<input name="days" type="number" value="4" min="1" required></label>
      </div>
      <button>Calcular split</button>
    </form>
    <div id="econ-box"></div>
    <h2 class="section">Cada país, su norma</h2>
    <div class="grid">${brief.countries.map((country) => `<article class="card"><h3>${FLAGS[country.code]} ${esc(country.name)}</h3><p><strong>${esc(country.privacyLaw)}</strong><br>${esc(country.privacyAuthority)}</p><p>${esc(country.privacyNote)}</p><p class="muted">${esc(country.invoiceSystem)} · ${esc(country.taxAuthority)} · ${esc(country.taxName)} ${pct(country.taxRate)}</p><p class="muted">${esc(country.safetyNote)}</p></article>`).join("")}</div>
    <h2 class="section">Residencia de datos</h2>
    <p>${esc(brief.principles.residency)}</p>
    <form class="panel" data-form="residency"><label>Correo a buscar en las cinco bases y en el plano global<select name="email">${emails}</select></label><button>Comprobar residencia</button></form>
    <div id="residency-box"></div>
  </section>`;
}

function renderResidency(result) {
  const cards = result.cells.map((cell) => `<article class="card"><h3>${esc(countryOf(cell.code)?.name || cell.code)}</h3>${cell.reachable === false ? "<p>La celda no respondió.</p>" : cell.found ? `<p><strong>Sí está aquí.</strong></p><p>${esc(cell.legalName)}<br>${esc(cell.email)}<br>${esc(cell.taxId)}<br>${esc(cell.phone)}</p>` : "<p>No tiene este correo.</p>"}</article>`).join("");
  const global = result.globalIndex;
  return `<div class="grid section">${cards}</div><div class="callout ${global.catalogHits || global.identityHits || global.eventHits ? "bad" : "good"}"><strong>Plano global.</strong> Correo almacenado: ${global.emailStored ? "sí" : "no"}. Coincidencias en anuncios ${esc(global.catalogHits)}, directorio ${esc(global.identityHits)}, eventos ${esc(global.eventHits)}. Campos del directorio: ${(global.storedIdentityFields || []).join(", ") || "seudónimo, celda y rol"}.</div>`;
}

async function view(route) {
  const [name, a, b] = route.parts;
  if (!name) return viewHome();
  if (name === "explorar" || name === "buscar") return viewExplore(route.params);
  if (name === "maquina") return viewMachine(a, b);
  if (name === "entrar") return viewLogin();
  if (name === "registro") return viewRegister();
  if (name === "confianza") return viewTrust();
  if (!session) return `<h1>${t("err.needSession")}</h1><p><a href="#/entrar">${t("err.enter")}</a></p>`;
  if (session.user.role === "admin" && ["publicar", "maquinas", "alquileres", "alquiler", "contrato"].includes(name)) {
    return `<h1>La filial no usa esta pantalla</h1><p>Desde aquí se revisan papeles, no se publican ni se alquilan máquinas.</p><p><a href="#/revision">Ir a revisión</a></p>`;
  }
  if (name === "revision") {
    if (session.user.role !== "admin") return `<h1>Solo la filial revisa papeles</h1><p>Entra con la cuenta de la filial de tu país.</p><p><a href="#/entrar">Ingresar</a></p>`;
    return viewReview();
  }
  if (name === "cuenta") return viewAccount();
  if (name === "publicar") return viewPublish();
  if (name === "maquinas") return viewOwnerMachines();
  if (name === "alquileres") return viewBookings();
  if (name === "alquiler") return viewBooking(a, b);
  if (name === "contrato") return viewContract(a, b);
  return `<h1>${t("err.missing")}</h1>`;
}

async function render() {
  const route = parseHash();
  document.documentElement.lang = currentLang();
  stopRentalClock();
  pendingRentalClock = null;
  try {
    app.innerHTML = shell(await view(route));
    if (route.path !== lastPath) {
      window.scrollTo(0, 0);
      lastPath = route.path;
    }
    if (pendingRentalClock) startRentalClock(pendingRentalClock);
  } catch (error) {
    stopRentalClock();
    app.innerHTML = shell(`<h1>${t("err.view")}</h1><p>${esc(error.message)}</p>`);
  }
}

async function login(cell, email, password) {
  const result = await api(`/api/cells/${cell}/auth/login`, { method: "POST", body: { email, password } });
  saveSession({ token: result.token, cell, user: result.user });
  if (!localStorage.getItem("maquirent.lang") && CELL_LANG[cell]) setLang(CELL_LANG[cell]);
  location.hash = result.user.role === "admin" ? "#/revision" : "#/cuenta";
  showToast(result.user.role === "admin" ? `Filial de ${countryName(cell)}` : countryName(cell));
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function actPayload(form) {
  const data = formData(form);
  const files = [...(form.querySelector("input[type=file]")?.files || [])].map((file) => file.name);
  const typed = String(data.photoNames || "").split(",").map((item) => item.trim()).filter(Boolean);
  const checklist = {};
  brief.checklist.forEach((label, index) => { checklist[label] = Boolean(form.querySelector(`[name=check${index}]`)?.checked); });
  return {
    hourMeter: Number(data.hourMeter),
    lat: Number(data.lat),
    lng: Number(data.lng),
    notes: data.notes || "",
    photos: [...files, ...typed],
    checklist,
    jointAcceptance: Boolean(form.querySelector("[name=jointAcceptance]")?.checked),
    damageClaim: Number(data.damageClaim || 0),
    idempotencyKey: `${form.dataset.id}:${form.dataset.form}:${data.hourMeter}:${(files.concat(typed)).join("|")}`,
  };
}

document.body.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  try {
    if (action === "close-paper") {
      event.preventDefault();
      closePaperViewer();
      return;
    }
    if (action === "view-paper") {
      event.preventDefault();
      const path = target.dataset.self
        ? `/api/cells/${session.cell}/me/papers/${encodeURIComponent(target.dataset.key)}`
        : `/api/cells/${session.cell}/admin/users/${encodeURIComponent(target.dataset.user)}/papers/${encodeURIComponent(target.dataset.key)}`;
      const doc = await api(path);
      await openPaperViewer(doc);
      return;
    }
    if (action === "view-ownership") {
      event.preventDefault();
      const doc = await api(`/api/cells/${session.cell}/admin/machines/${encodeURIComponent(target.dataset.id)}/ownership`);
      await openPaperViewer(doc);
      return;
    }
    if (action === "logout") {
      event.preventDefault();
      closePaperViewer();
      saveSession(null);
      if (location.hash !== "#/") location.hash = "#/";
      else await render();
      showToast("Sesión cerrada en este navegador.");
      return;
    }
    if (action === "demo-login") {
      event.preventDefault();
      await login(target.dataset.cell, target.dataset.email, demo.password);
      return;
    }
    if (action === "preview-quote") {
      const form = target.closest("form");
      const data = formData(form);
      assertBookDates(data, form.dataset.minStart);
      const home = session?.cell || form.dataset.cell;
      const quote = await api(`/api/cells/${form.dataset.cell}/quote?machineId=${form.dataset.machine}&start=${data.startDate}&end=${data.endDate}&homeCell=${home}`);
      document.querySelector("#quote-box").innerHTML = economics(quote.quote);
      return;
    }
    if (action === "geo" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((position) => {
        const form = target.closest("form");
        form.querySelector("[name=lat]").value = position.coords.latitude.toFixed(5);
        form.querySelector("[name=lng]").value = position.coords.longitude.toFixed(5);
      });
      return;
    }
  } catch (error) {
    const box = document.querySelector("#quote-box");
    if (action === "preview-quote" && box) box.innerHTML = `<div class="callout bad">${esc(error.message)}</div>`;
    showToast(error.message, true);
  }
});

document.body.addEventListener("change", (event) => {
  const input = event.target;
  if (input?.name === "cell" && input.form?.dataset.form === "register") applyRegisterPack(input.form, input.value);
  if (input?.name === "startDate" && input.form?.dataset.form === "book") syncReturnMin(input.form);
  if (input?.name === "uiLang") {
    setLang(input.value);
    render();
  }
});

document.body.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.form) return;
  event.preventDefault();
  const kind = form.dataset.form;
  const data = formData(form);
  form.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    if (kind === "search") {
      const params = new URLSearchParams();
      if (data.q) params.set("q", data.q);
      if (data.country) params.set("country", data.country);
      if (data.category) params.set("category", data.category);
      if (form.querySelector("[name=includeUnverified]")?.checked) params.set("includeUnverified", "1");
      const query = params.toString();
      const next = query ? `#/explorar?${query}` : "#/explorar";
      if (location.hash === next) await render();
      else location.hash = next;
      return;
    }
    if (kind === "login") {
      await login(data.cell, data.email, data.password);
      return;
    }
    if (kind === "forgot") {
      showToast("Si ese correo está registrado en ese país, enviaremos las instrucciones para restablecer la contraseña.");
      return;
    }
    if (kind === "register") {
      if (data.password !== data.password2) throw new Error("Las contraseñas no coinciden.");
      const pack = brief.onboarding[data.cell];
      const papers = {};
      for (const paper of pack.papers) {
        const upload = form.querySelector(`[name=file_${paper.key}]`)?.files?.[0];
        if (!upload) throw new Error(`Adjunta el archivo de: ${paper.title}.`);
        const file = await readUpload(upload);
        papers[paper.key] = {
          file: file.file,
          mime: file.mime,
          content: file.content,
          reference: data[`ref_${paper.key}`] || "",
          insurer: paper.needsPolicy ? data.insurer : "",
          expires: paper.needsPolicy ? data.expires : "",
        };
      }
      const result = await api(`/api/cells/${data.cell}/auth/register`, {
        method: "POST",
        body: {
          role: "renter",
          legalName: data.legalName,
          taxId: data.taxId,
          email: data.email,
          phone: data.phone,
          address: data.address,
          city: data.city,
          password: data.password,
          acceptTerms: Boolean(form.querySelector("[name=acceptTerms]")?.checked),
          dossier: {
            tradeName: data.tradeName,
            legalForm: data.legalForm,
            representativeName: data.representativeName,
            representativeId: data.representativeId,
            papers,
          },
        },
      });
      saveSession({ token: result.token, cell: data.cell, user: result.user });
      if (!localStorage.getItem("maquirent.lang") && CELL_LANG[data.cell]) setLang(CELL_LANG[data.cell]);
      location.hash = "#/cuenta";
      showToast("Cuenta creada. El expediente quedó en revisión.");
      return;
    }
    if (kind === "resubmit-dossier") {
      session.user = await api(`/api/cells/${session.cell}/me/resubmit`, { method: "POST", body: {} });
      saveSession(session);
      await render();
      showToast("El expediente volvió a la filial. Sigue sin poder reservar hasta que lo aprueben.");
      return;
    }
    if (kind === "admin-review") {
      const decision = event.submitter?.value;
      if (!decision) throw new Error("Elige aprobar o rechazar.");
      if (decision === "rejected" && String(data.note || "").trim().length < 8) throw new Error("Escribe el motivo del rechazo.");
      await api(`/api/cells/${session.cell}/admin/reviews`, {
        method: "POST",
        body: { kind: form.dataset.kind, id: form.dataset.id, decision, note: data.note || "" },
      });
      await render();
      showToast(decision === "approved" ? "Aprobado. Ya puede operar en este país." : "Rechazado. La empresa verá el motivo en su cuenta.");
      return;
    }
    if (kind === "publish") {
      const files = [...(form.querySelector("[name=photos]")?.files || [])];
      if (!files.length) throw new Error("Sube al menos una foto de la máquina.");
      if (files.length > 4) throw new Error("Puedes subir hasta 4 fotos.");
      const photos = await Promise.all(files.map(readUpload));
      const { photos: _ignoredPhotos, ...fields } = data;
      await api(`/api/cells/${session.cell}/machines`, {
        method: "POST",
        body: {
          ...fields,
          photos,
          operatorRequired: Boolean(form.querySelector("[name=operatorRequired]")?.checked),
        },
      });
      location.hash = "#/maquinas";
      showToast("Publicación enviada. La filial debe aprobar fotos y factura antes de que se pueda reservar.");
      return;
    }
    if (kind === "submit-ownership") {
      const files = [...(form.querySelector("[name=photos]")?.files || [])];
      const body = { ownershipDoc: data.ownershipDoc };
      if (files.length) {
        if (files.length > 4) throw new Error("Puedes subir hasta 4 fotos.");
        body.photos = await Promise.all(files.map(readUpload));
      }
      await api(`/api/cells/${session.cell}/machines/${form.dataset.id}/ownership`, { method: "POST", body });
      await render();
      showToast("Publicación enviada otra vez. La filial tiene que aprobarla.");
      return;
    }
    if (kind === "book") {
      assertBookDates(data, form.dataset.minStart);
      const created = await api(cellPath(form.dataset.cell, "/bookings"), {
        method: "POST",
        body: {
          machineId: form.dataset.machine,
          startDate: data.startDate,
          endDate: data.endDate,
          homeCell: session.cell,
          idempotencyKey: `${session.user.id}:${form.dataset.machine}:${data.startDate}:${data.endDate}`,
        },
      });
      location.hash = `#/alquiler/${form.dataset.cell}/${created.id}`;
      showToast(created.replayed ? "Esa solicitud ya existía." : "Reserva solicitada en la celda del propietario.");
      return;
    }
    if (kind === "economics") {
      const info = countryOf(data.cell);
      const dailyRate = Math.round(Number(data.dailyRate) * info.minorUnit);
      const quote = await api(`/api/global/quote?cell=${data.cell}&dailyRate=${dailyRate}&days=${data.days}`);
      document.querySelector("#econ-box").innerHTML = economics(quote.quote);
      return;
    }
    if (kind === "residency") {
      const result = await api(`/api/residency?email=${encodeURIComponent(data.email)}`);
      document.querySelector("#residency-box").innerHTML = renderResidency(result);
      return;
    }
    const cell = form.dataset.cell || session.cell;
    const id = form.dataset.id;
    let payload = { ...data, homeCell: session.cell, idempotencyKey: `${id}:${kind}` };
    if (kind === "deliver" || kind === "return") payload = { ...actPayload(form), homeCell: session.cell };
    const updated = await api(cellPath(cell, `/bookings/${id}/${kind}`), { method: "POST", body: payload });
    location.hash = `#/alquiler/${cell}/${id}`;
    await render();
    showToast(updated.replayed ? "Ese paso ya se había aplicado." : `Estado: ${updated.stateLabel}.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    form.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
});

window.addEventListener("hashchange", render);

const [loadedBrief, loadedDemo] = await Promise.all([api("/api/global/brief"), api("/api/demo")]);
brief = loadedBrief;
demo = loadedDemo;
if (session?.token) {
  try { session.user = await api(`/api/cells/${session.cell}/me`); saveSession(session); }
  catch { saveSession(null); }
}
if (!location.hash) location.hash = "#/";
render();
