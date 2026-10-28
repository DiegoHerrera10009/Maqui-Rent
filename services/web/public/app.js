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

function pct(rate) {
  return new Intl.NumberFormat("es-CO", { style: "percent", maximumFractionDigits: 1 }).format(rate);
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
    const error = new Error(data.error || "No se pudo completar la operación.");
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function shell(content) {
  const user = session?.user;
  return `<div class="wrap">
    <header class="top">
      <a class="logo" href="#/">Maqui<span>Rent</span></a>
      <nav>
        <a href="#/buscar">Buscar</a>
        <a href="#/confianza">Confianza</a>
        <a href="#/arquitectura">Arquitectura</a>
        ${user ? `<a href="#/cuenta">Mi cuenta</a><a href="#/publicar">Publicar</a><a href="#/alquileres">Alquileres</a>` : ""}
        ${user ? `<a class="me" href="#/cuenta">${esc(user.legalName)}</a><a href="#/" data-action="logout">Salir</a>` : `<a href="#/entrar">Ingresar</a><a href="#/registro">Registrarse</a>`}
      </nav>
    </header>
    <div class="rail">${brief.countries.map((country) => `<a href="#/buscar?country=${country.code}">${FLAGS[country.code]} ${esc(country.name)} · ${esc(country.language)}</a>`).join("")}</div>
    <main>${content}</main>
    <p class="footer">Boceto funcional. Los pagos, la verificación y la factura electrónica son adaptadores simulados. MaquiRent intermedia: no es el arrendatario y no custodia el dinero. ${esc(brief.fx.note)}</p>
  </div>`;
}

function photoOf(machine) {
  const id = machine.machineId || machine.id;
  const known = ["co-cat-320", "co-toyota-8f", "co-jd-310", "us-bobcat-t770", "us-jlg-600s", "us-cat-d6", "br-jcb-3cx", "br-liebherr-ltm", "br-schwing", "de-liebherr-r920", "de-manitou", "de-hamm", "fr-volvo-ec220", "fr-haulotte", "fr-cat-cs"];
  return known.includes(id) ? `/machines/${id}.jpg` : "";
}

function machineCard(machine) {
  const photo = photoOf(machine);
  return `<a class="machine" href="#/maquina/${machine.cell}/${machine.machineId}">
    ${photo ? `<img class="shot" src="${photo}" alt="">` : ""}
    <div class="badges"><span class="badge">${FLAGS[machine.cell]} ${esc(machine.country)}</span><span class="badge">${esc(machine.language)}</span><span class="badge">${esc(machine.category)}</span></div>
    <h3>${esc(machine.title)}</h3>
    <p class="muted">${esc(machine.city)} · ${esc(machine.brand)} ${esc(machine.model)}</p>
    <p>${esc(machine.description)}</p>
    <div class="price">${money(machine.dailyRate, machine.cell)} <span class="muted">/ día</span></div>
    <p class="muted">${machine.bookable ? "Propiedad verificada" : "Propiedad por verificar"} · ${machine.blocks?.length ? "Tiene fechas ocupadas" : "Sin bloqueos replicados"}</p>
  </a>`;
}

function billRow(label, hint, amount, cell) {
  return `<div class="bill-row"><span>${label}${hint ? `<small>${hint}</small>` : ""}</span><b>${money(amount, cell)}</b></div>`;
}

function economics(quote) {
  const cell = quote.cell;
  const transport = quote.logistics
    ? billRow("Transporte", `Ida y vuelta, ${esc(quote.logistics.transitDays)} días. Lo cobra el transportista.`, quote.transport || 0, cell)
    : "";
  return `<div class="quote">
    <p class="kicker">Precio final</p>
    <div class="bill-total">
      <span>Total a pagar<small>Lo cobra el procesador y queda retenido hasta la devolución.</small></span>
      <b>${money(quote.charged, cell)}</b>
    </div>
    <h3>De qué se compone ese total</h3>
    <div class="bill">
      ${billRow("Arrendamiento", "Precio de la máquina. Lo factura el propietario.", quote.rental, cell)}
      ${billRow("Tarifa de servicio, 5%", "MaquiRent se la cobra a quien usa la máquina.", quote.serviceFee, cell)}
      ${billRow("Protección", "Cubre el equipo y la responsabilidad civil.", quote.protection, cell)}
      ${transport}
    </div>
    <div class="commission">
      <h3>Comisión, 8%</h3>
      <p>Se descuenta del arrendamiento de ${money(quote.rental, cell)}, que ya está completo dentro del total a pagar.</p>
      <div class="bill">
        ${billRow("El propietario recibe", null, quote.ownerPayout, cell)}
        ${billRow("Comisión de MaquiRent", null, quote.ownerCommission, cell)}
      </div>
    </div>
    <div class="aside-pay">
      <h3>Depósito, aparte del total</h3>
      ${billRow("Garantía", "Se preautoriza y se libera si el acta no declara un daño.", quote.deposit, cell)}
    </div>
    <details class="inside">
      <summary>Reparto interno, ya incluido en el total</summary>
      <div class="bill">
        ${billRow("Al propietario", "Arrendamiento menos la comisión del 8%.", quote.ownerPayout, cell)}
        ${billRow("Comisión 8%", "Sale del arrendamiento.", quote.ownerCommission, cell)}
        ${billRow("Al asegurador", "La mayor parte de la protección.", quote.protectionInsurer, cell)}
        ${billRow("A la filial, por la protección", "El resto de la protección.", quote.protectionPlatform, cell)}
        ${billRow(`Procesador ${esc(quote.provider)}`, `${pct(quote.processorFeeRate)} del alquiler y las tarifas. Sale de la parte de la filial.`, quote.processorFee, cell)}
        ${billRow("La filial se queda con", `${pct(quote.marginOnRental)} del arrendamiento, después del procesador.`, quote.platformNet, cell)}
        ${quote.logistics ? billRow("Al transportista", "El flete completo.", quote.transport || 0, cell) : ""}
      </div>
      ${quote.logistics ? `<p class="muted">La máquina sale el ${esc(quote.logistics.dispatchDate)} y vuelve a estar libre el ${esc(quote.logistics.returnBy)} (${esc(quote.logistics.mode)}).</p>` : `<p class="muted">En la ficha de la máquina este cálculo también suma el flete desde tu país.</p>`}
    </details>
  </div>`;
}

async function viewHome() {
  const result = await api("/api/global/search");
  return `<section class="hero">
    <div>
      <p class="kicker">Marketplace de maquinaria</p>
      <h1>Búscala en cinco países. El viaje entra en el precio.</h1>
      <p class="lede">Colombia, Estados Unidos, Brasil, Alemania y Francia tienen cada uno su celda. MaquiRent intermedia entre quien publica la máquina y quien la usa. Si están en países distintos, la cotización suma los días y el flete.</p>
    </div>
    <form class="panel" data-form="search">
      <label>Qué máquina buscas<input name="q" placeholder="Excavadora, grúa, nacelle, Bagger"></label>
      <label>País<select name="country"><option value="">Los cinco</option>${brief.countries.map((country) => `<option value="${country.code}">${esc(country.name)}</option>`).join("")}</select></label>
      <button>Buscar en el índice global</button>
    </form>
  </section>
  <section class="grid countries">${brief.countries.map((country) => `<article class="card"><p class="kicker">${FLAGS[country.code]} ${esc(country.language)}</p><h3>${esc(country.name)}</h3><p>${esc(country.subsidiary)}</p><p class="muted">${esc(country.provider)} · ${esc(country.invoiceSystem)} · ${esc(country.taxAuthority)}</p></article>`).join("")}</section>
  <section class="section grid">
    <article class="card"><h3>1. Buscar</h3><p>El índice replica los anuncios por el bus. Puede ir un instante detrás de la celda.</p></article>
    <article class="card"><h3>2. Reservar</h3><p>Solo escribe la celda del propietario. Dos empresas no confirman la misma fecha.</p></article>
    <article class="card"><h3>3. Retener y repartir</h3><p>El procesador cobra, guarda el depósito y hace el split. MaquiRent no custodia el alquiler.</p></article>
  </section>
  <section class="section">
    <h2>Anuncios ya replicados</h2>
    <div class="grid">${brief.countries.map((country) => result.machines.find((machine) => machine.cell === country.code)).filter(Boolean).map(machineCard).join("")}</div>
  </section>`;
}

async function viewSearch(params) {
  const q = params.get("q") || "";
  const country = params.get("country") || "";
  const category = params.get("category") || "";
  const includeUnverified = params.get("includeUnverified") === "1";
  const result = await api(`/api/global/search?q=${encodeURIComponent(q)}&country=${encodeURIComponent(country)}&category=${encodeURIComponent(category)}&includeUnverified=${includeUnverified ? "1" : "0"}`);
  const categories = ["Excavación", "Elevación", "Carga", "Compactación", "Concreto", "Grúa"];
  return `<section class="section">
    <p class="kicker">Índice global · consistencia eventual</p>
    <h1>Buscar maquinaria</h1>
    <form class="panel" data-form="search">
      <div class="grid">
        <label>Texto<input name="q" value="${esc(q)}"></label>
        <label>País<select name="country"><option value="">Todos</option>${brief.countries.map((item) => `<option value="${item.code}" ${item.code === country ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label>
        <label>Categoría<select name="category"><option value="">Todas</option>${categories.map((item) => `<option ${item === category ? "selected" : ""}>${esc(item)}</option>`).join("")}</select></label>
      </div>
      <label class="check"><input type="checkbox" name="includeUnverified" ${includeUnverified ? "checked" : ""}> Incluir máquinas con la propiedad todavía sin verificar</label>
      <button>Actualizar búsqueda</button>
    </form>
    <p class="muted">${result.total} anuncios. Ver uno no reserva: la fecha se confirma en la celda del propietario.</p>
    <div class="grid">${result.machines.map(machineCard).join("") || `<p>No hay anuncios con ese filtro.</p>`}</div>
  </section>`;
}

async function viewMachine(cell, id) {
  const globalResult = await api(`/api/global/machines/${cell}/${id}`).catch((error) => ({ error }));
  const cellResult = await api(`/api/cells/${cell}/machines/${id}`).catch((error) => ({ error }));
  const machine = cellResult.machine || globalResult.machine;
  if (!machine) return `<h1>Máquina no disponible</h1><p>${esc(globalResult.error?.message || cellResult.error?.message || "Sin datos")}</p>`;
  const globalBlocks = JSON.stringify(globalResult.machine?.blocks || []);
  const cellBlocks = JSON.stringify(cellResult.machine?.blocks || []);
  const diverged = globalResult.machine && cellResult.machine && globalBlocks !== cellBlocks;
  const info = countryOf(cell);
  const logistics = session ? await api(`/api/cells/${cell}/logistics?homeCell=${session.cell}`).catch(() => null) : null;
  const trip = logistics ? (logistics.sameCountry
    ? `Traslado dentro de ${esc(logistics.originName)}: ${esc(logistics.transitDays)} días de ida y vuelta. Entrega más temprana ${esc(logistics.earliestStart)}. Flete ${money(logistics.transport, cell)}.`
    : `Tu cuenta está en ${esc(logistics.destinationName)} y la máquina está en ${esc(logistics.originName)}. El transporte tarda ${esc(logistics.transitDays)} días (${esc(logistics.mode)}). No se puede entregar antes del ${esc(logistics.earliestStart)}. Flete de ida y vuelta ${money(logistics.transport, cell)}. La máquina sigue ocupada hasta que vuelve.`)
    : "Entra con tu cuenta para ver cuántos días tarda el transporte desde tu país y cuánto cuesta el flete.";
  return `<section class="section grid two">
    <div>
      ${photoOf({ ...machine, id }) ? `<img class="shot-lg" src="${photoOf({ ...machine, id })}" alt="">` : ""}
      <p class="kicker">${FLAGS[cell]} ${esc(info.name)} · ${esc(info.language)} · contrato en esta celda</p>
      <h1>${esc(machine.title || globalResult.machine.title)}</h1>
      <p class="lede">${esc(machine.description || "")}</p>
      <p>${esc(machine.city)} · ${esc(machine.brand)} ${esc(machine.model)} · ${esc(machine.year)} · horómetro ${esc(machine.hourMeter)}</p>
      <p class="price">${money(machine.dailyRate, cell)} <span class="muted">/ día</span></p>
      <div class="badges">
        <span class="badge">${machine.ownershipVerified || machine.ownershipStatus === "verified" ? "Propiedad verificada" : "Propiedad pendiente"}</span>
        <span class="badge">${machine.operatorRequired ? "Exige operador certificado" : "Operador no exigido"}</span>
        <span class="badge">Seudónimo ${esc(machine.ownerPseudonym || "")}</span>
        ${machine.tradeName ? `<span class="badge">En la celda: ${esc(machine.tradeName)}</span>` : ""}
      </div>
      ${diverged ? `<div class="callout">El índice global y la celda no muestran las mismas fechas. La búsqueda va detrás; la reserva usa la celda.</div>` : `<div class="callout good">Índice y celda coinciden en las fechas ocupadas que ya se replicaron.</div>`}
      ${cellResult.error ? `<div class="callout bad">La celda de ${esc(info.name)} no entregó la ficha: ${esc(cellResult.error.message)}. El anuncio del índice puede seguir visible.</div>` : ""}
      <h3>Ocupación según el índice, viaje incluido</h3>
      ${blockList(globalResult.machine?.blocks)}
      <h3>Ocupación según la celda, viaje incluido</h3>
      ${cellResult.machine ? blockList(cellResult.machine.blocks) : `<p class="muted">La celda no respondió.</p>`}
    </div>
    <form class="panel" data-form="book" data-cell="${cell}" data-machine="${id}">
      <p class="kicker">Reservar</p>
      <h3>${money(machine.dailyRate, cell)} / día</h3>
      <div class="callout">${trip}</div>
      <p class="muted">MaquiRent no alquila la máquina: intermedia entre quien la publica y quien la usa.</p>
      <label>Entrega en obra<input type="date" name="startDate" required ${logistics ? `min="${esc(logistics.earliestStart)}"` : ""}></label>
      <label>Devolución en obra<input type="date" name="endDate" required ${logistics ? `min="${esc(logistics.earliestStart)}"` : ""}></label>
      <button type="button" data-action="preview-quote">Calcular precio</button>
      <div id="quote-box"></div>
      ${session ? `<button>Solicitar</button>` : `<a class="button" href="#/entrar">Entra para solicitar</a>`}
    </form>
  </section>`;
}

function blockList(blocks = []) {
  if (!blocks.length) return `<p class="muted">Sin fechas ocupadas.</p>`;
  return `<ul>${blocks.map((block) => `<li>${esc(block.startDate)} → ${esc(block.endDate)} · ${esc(brief.states[block.state] || block.state)}</li>`).join("")}</ul>`;
}

function viewLogin() {
  const recovering = location.hash.includes("recuperar");
  const groups = brief.countries.map((country) => {
    const accounts = demo.accounts.filter((account) => account.cell === country.code);
    return `<div class="demo-country"><h3>${FLAGS[country.code]} ${esc(country.name)}</h3>${accounts.map((account) => `<button class="account" type="button" data-action="demo-login" data-cell="${account.cell}" data-email="${esc(account.email)}"><strong>${esc(account.legalName)}</strong><br><span class="muted">${esc(account.email)}</span></button>`).join("")}</div>`;
  }).join("");
  return `<section class="login-layout">
    <div class="login-pair">
      <form class="panel" data-form="login" ${recovering ? "hidden" : ""}>
        <p class="kicker">Cuenta de empresa</p>
        <h1>Ingresa</h1>
        <p>Usa el correo con el que registraste la empresa y la contraseña.</p>
        <label>País donde registraste la empresa<select name="cell">${brief.countries.map((country) => `<option value="${country.code}">${esc(country.name)}</option>`).join("")}</select></label>
        <label>Correo<input name="email" type="email" autocomplete="username" required></label>
        <label>Contraseña<input name="password" type="password" autocomplete="current-password" required></label>
        <button>Ingresar</button>
        <p class="switch"><a href="#/entrar?recuperar=1">¿Olvidaste tu contraseña?</a></p>
      </form>
      <form class="panel" data-form="forgot" ${recovering ? "" : "hidden"}>
        <h2>Recuperar contraseña</h2>
        <p class="muted">Indica el país y el correo de la empresa. Si existe una cuenta, enviamos las instrucciones allí.</p>
        <label>País<select name="cell">${brief.countries.map((country) => `<option value="${country.code}">${esc(country.name)}</option>`).join("")}</select></label>
        <label>Correo<input name="email" type="email" required></label>
        <button>Enviar instrucciones</button>
        <p class="switch"><a href="#/entrar">Volver a ingresar</a></p>
      </form>
      <aside class="panel register-cta">
        <h2>¿La empresa aún no tiene cuenta?</h2>
        <p>El registro pide cámara de comercio, registro fiscal, cédula del representante, póliza y certificado del operador. Sin ese expediente no se puede alquilar.</p>
        <a class="button" href="#/registro">Registrarse</a>
      </aside>
    </div>
    <details class="demo">
      <summary>Cuentas de demostración</summary>
      <p class="muted">Contraseña ${esc(demo.password)}. Sirven para recorrer el boceto sin cargar documentos.</p>
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

function kycLabel(status) {
  return { pending: "En revisión", verified: "Habilitada para alquilar" }[status] || status;
}

function operatorLabel(status) {
  return { none: "Sin certificado", pending: "En revisión", verified: "Verificado" }[status] || status;
}

function dossierPanel(user, info) {
  if (!user.dossier?.papers) {
    return `<article class="card"><h3>Expediente</h3><p>${user.kycStatus === "verified" ? "Esta empresa ya puede alquilar." : "Falta el expediente de la empresa."}</p><p class="muted">${esc(info.safetyNote)}</p></article>`;
  }
  const papers = Object.values(user.dossier.papers);
  return `<article class="card">
    <h3>Expediente para alquilar</h3>
    <p>${esc(user.dossier.legalForm || "")}${user.dossier.representativeName ? ` · representante ${esc(user.dossier.representativeName)}` : ""}</p>
    <p>${user.kycStatus === "verified" ? "Revisado. La empresa puede reservar maquinaria." : "Recibido. La filial lo revisa antes de permitir una reserva."}</p>
    <ul>${papers.map((paper) => `<li><strong>${esc(paper.title)}</strong><br><span class="muted">${esc(paper.file)}${paper.reference ? ` · ${esc(paper.reference)}` : ""}${paper.insurer ? ` · ${esc(paper.insurer)} hasta ${esc(paper.expires)}` : ""}</span></li>`).join("")}</ul>
    ${user.kycStatus === "verified" ? "" : `<form data-form="review-dossier"><p class="muted">En este boceto la revisión de la filial es inmediata.</p><button>Marcar expediente como revisado</button></form>`}
  </article>`;
}

function machineMine(machine) {
  return `<article class="card">
    <h3><a href="#/maquina/${session.cell}/${machine.id}">${esc(machine.title)}</a></h3>
    <p>${money(machine.dailyRate, session.cell)} / día · ${esc(machine.city)}</p>
    <p>Propiedad: <strong>${esc(machine.ownershipStatus)}</strong></p>
    ${machine.ownershipStatus !== "verified" ? `<form data-form="verify-ownership" data-id="${machine.id}"><label>Factura o registro<input name="ownershipDoc" value="${esc(machine.ownershipDoc || "")}"></label><button>Verificar propiedad</button></form>` : `<p class="muted">Visible en la búsqueda. Quien la reserve ve el viaje y el flete desde su país.</p>`}
  </article>`;
}

async function viewAccount() {
  const user = session.user;
  const info = countryOf(user.cell);
  const result = await api(`/api/cells/${session.cell}/machines`);
  const mine = result.machines.filter((machine) => machine.ownerPseudonym === user.pseudonym);
  return `<section class="section grid two">
    <div>
      <p class="kicker">${FLAGS[user.cell]} ${esc(info.name)}</p>
      <h1>${esc(user.legalName)}</h1>
      <p>Seudónimo ${esc(user.pseudonym)}. Con esta cuenta publicas y también alquilas.</p>
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
    <div class="bar"><h2>Máquinas que publicaste</h2><a class="button" href="#/publicar">Publicar otra</a></div>
    <div class="grid">${mine.map(machineMine).join("") || `<p>Todavía no publicas equipos. <a href="#/publicar">Publica la primera</a>.</p>`}</div>
  </section>`;
}

function viewPublish() {
  const info = countryOf(session.cell);
  return `<section class="section" style="max-width:760px">
    <h1>Publicar en ${esc(info.name)}</h1>
    <p>Cualquier cuenta verificada puede publicar, también si la abriste para alquilar. La tarifa se escribe en ${esc(info.currency)} y al lado se muestra el equivalente en dólares. La máquina no se puede reservar hasta verificar la factura o el registro.</p>
    <form class="panel" data-form="publish">
      <label>Título<input name="title" required></label>
      <label>Categoría<select name="category">${["Excavación", "Elevación", "Carga", "Compactación", "Concreto", "Grúa"].map((item) => `<option>${esc(item)}</option>`).join("")}</select></label>
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
      <label>Factura o registro del equipo<input name="ownershipDoc" placeholder="FAC-2026-100"></label>
      <label class="check"><input type="checkbox" name="operatorRequired" checked> Exigir operador certificado</label>
      <button>Publicar en la celda</button>
    </form>
  </section>`;
}

async function viewOwnerMachines() {
  const result = await api(`/api/cells/${session.cell}/machines`);
  const mine = result.machines.filter((machine) => machine.ownerPseudonym === session.user.pseudonym);
  return `<section class="section"><div class="bar"><h1>Mis máquinas</h1><a class="button" href="#/publicar">Publicar otra</a></div><div class="grid">${mine.map(machineMine).join("") || `<p>Todavía no publicas equipos. <a href="#/publicar">Publica la primera</a>.</p>`}</div></section>`;
}

async function viewBookings() {
  const result = await api(`/api/my/bookings?homeCell=${session.cell}`);
  return `<section class="section"><h1>Alquileres de tu cuenta</h1><p class="muted">Aquí están los contratos en los que publicaste la máquina y aquellos en los que la usas, también si la máquina está en otro país.</p><div class="grid">${result.bookings.map((booking) => `<a class="card" href="#/alquiler/${booking.cell}/${booking.id}"><p class="kicker">${FLAGS[booking.cell]} ${esc(booking.stateLabel)} · ${booking.side === "owner" ? "La publicaste" : "La vas a usar"}</p><h3>${esc(booking.machine.title)}</h3><p>En obra ${esc(booking.startDate)} → ${esc(booking.endDate)}</p><p>${money(booking.quote.charged, booking.cell)} retenidos o pactados</p></a>`).join("") || "<p>No hay alquileres todavía.</p>"}</div></section>`;
}

async function viewBooking(cell, id) {
  const booking = await api(cellPath(cell, `/bookings/${id}`));
  const info = countryOf(cell);
  return `<section class="section">
    <p class="kicker">${FLAGS[cell]} ${esc(info.name)} · ${esc(booking.id)}</p>
    <h1>${esc(booking.machine.title)}</h1>
    <p>En obra ${esc(booking.startDate)} → ${esc(booking.endDate)}. ${booking.dispatchDate ? `La máquina sale el ${esc(booking.dispatchDate)} y vuelve a estar libre el ${esc(booking.returnBy)}.` : ""}</p>
    <p>${esc(booking.parties.owner.legalName)} es el propietario. ${esc(booking.parties.renter.legalName)} es el arrendatario. MaquiRent solo intermedia.</p>
    ${stepper(booking.state)}
    <div class="grid two">
      <div>
        ${economics(booking.quote)}
        <div class="card section">${actionsFor(booking, cell)}</div>
        <h3>Saga</h3>
        <ul>${booking.steps.map((step) => `<li><strong>${esc(step.step)}</strong> · ${esc(step.createdAt)}</li>`).join("")}</ul>
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

function actionsFor(booking, cell) {
  if (booking.state === "requested") {
    return `<h3>Pagar y retener</h3><p class="muted">${esc(countryOf(cell).bankNote)}</p>
      <form data-form="pay" data-id="${booking.id}" data-cell="${cell}">
        <label>Medio<select name="method"><option value="card">Tarjeta, vía ${esc(booking.quote.provider)}</option><option value="bank_transfer">Transferencia conciliada por ${esc(booking.quote.provider)}</option></select></label>
        <button>Cobrar y retener en el procesador</button>
      </form>
      ${cancelBox(booking, cell)}`;
  }
  if (booking.state === "paid_held") return `${actForm("deliver", "Acta de entrega", booking, cell)}${cancelBox(booking, cell)}${disputeForm(booking, cell)}`;
  if (booking.state === "delivered") return `${actForm("return", "Acta de devolución", booking, cell)}${disputeForm(booking, cell)}`;
  if (booking.state === "returned") {
    return `<form data-form="settle" data-id="${booking.id}" data-cell="${cell}"><p>El procesador puede repartir el cobro porque ya hay acta de devolución.</p><button>Liquidar y hacer el split</button></form>${disputeForm(booking, cell)}`;
  }
  if (booking.state === "disputed") {
    return `<form data-form="mediate" data-id="${booking.id}" data-cell="${cell}"><label>Nota de mediación<textarea name="note" required></textarea></label><button>Añadir nota</button></form>
      <form data-form="resolve" data-id="${booking.id}" data-cell="${cell}"><label>Acuerdo<select name="outcome"><option value="release_owner">Liberar al propietario</option><option value="refund_renter">Reembolsar al arrendatario</option><option value="split">Partir el arrendamiento</option></select></label><button>Registrar acuerdo</button></form>
      <p class="muted">Si no hay acuerdo, el foro es ${esc(booking.forum)}.</p>`;
  }
  return `<p>Este alquiler está en ${esc(booking.stateLabel)}. No hay un paso de dinero pendiente en la saga.</p>`;
}

function cancelBox(booking, cell) {
  if (!booking.cancellation) return "";
  return `<form data-form="cancel" data-id="${booking.id}" data-cell="${cell}"><h3>Cancelar</h3><p><strong>${esc(booking.cancellation.title)}</strong>. ${esc(booking.cancellation.detail)}</p><button class="secondary" type="submit">Aplicar esta política</button></form>`;
}

function disputeForm(booking, cell) {
  return `<form data-form="dispute" data-id="${booking.id}" data-cell="${cell}"><h3>Abrir disputa</h3><label>Qué pasó<textarea name="note" required></textarea></label><button class="danger" type="submit">Pasar a mediación</button></form>`;
}

function actForm(kind, title, booking, cell) {
  const checks = brief.checklist.map((label, index) => `<label class="check"><input type="checkbox" name="check${index}" checked> ${esc(label)}</label>`).join("");
  return `<form data-form="${kind}" data-id="${booking.id}" data-cell="${cell}">
    <h3>${title}</h3>
    <label>Horómetro<input name="hourMeter" type="number" required value="${esc(booking.machine.hourMeter)}"></label>
    <div class="grid"><label>Latitud<input name="lat" required value="${esc(booking.machine.lat)}"></label><label>Longitud<input name="lng" required value="${esc(booking.machine.lng)}"></label></div>
    <button type="button" class="secondary" data-action="geo">Usar mi ubicación</button>
    ${checks}
    <label>Fotos (archivos)<input name="photos" type="file" accept="image/*" multiple></label>
    <label>O nombres de foto, separados por coma<input name="photoNames" placeholder="frente.jpg, horometro.jpg"></label>
    ${kind === "return" ? `<label>Daño a descontar del depósito, en unidades mínimas<input name="damageClaim" type="number" value="0"></label>` : ""}
    <label>Notas<textarea name="notes"></textarea></label>
    <label class="check"><input type="checkbox" name="jointAcceptance" required> La contraparte está presente y acepta esta acta.</label>
    <button>Registrar ${title.toLowerCase()}</button>
  </form>`;
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

async function viewArchitecture() {
  const health = await api("/api/global/health");
  const identities = await api("/api/global/identities");
  const feed = await api("/api/global/feed");
  return `<section class="section"><p class="kicker">Celdas, bus y plano</p><h1>Una caída se queda en su país</h1>
    <p>${esc(brief.principles.consistency)}</p>
    <div class="diagram">
      <div class="plane">Plano global · ${health.catalog} anuncios · ${health.identities} seudónimos</div>
      <div class="busline">Bus de eventos · la celda publica desde su bandeja de salida y el plano consume en orden</div>
      <div class="cells">${brief.countries.map((country) => {
        const status = health.cells[country.code] || {};
        return `<article class="cellbox ${status.up && status.accepting !== false ? "" : "down"}"><strong>${esc(country.name)}</strong><p>${status.up ? (status.accepting ? "Operando" : "Proceso vivo, operación pausada") : "Sin respuesta"}</p><p class="muted">Salida pendiente: ${esc(status.outboxPending ?? "—")}${status.holdOutbox ? " · bus retenido" : ""}</p>
          <div class="actions"><button class="secondary" data-action="toggle-cell" data-cell="${country.code}" data-accepting="${status.accepting ? "0" : "1"}">${status.accepting ? "Pausar" : "Reanudar"}</button><button class="secondary" data-action="toggle-bus" data-cell="${country.code}" data-hold="${status.holdOutbox ? "0" : "1"}">${status.holdOutbox ? "Soltar bus" : "Retener bus"}</button></div></article>`;
      }).join("")}</div>
    </div>
    <h2 class="section">Directorio mínimo</h2>
    <div class="table-wrap"><table><thead><tr><th>Seudónimo</th><th>Celda</th><th>Rol</th></tr></thead><tbody>${identities.identities.map((item) => `<tr><td>${esc(item.pseudonym)}</td><td>${esc(item.cell)}</td><td>${esc(item.role)}</td></tr>`).join("")}</tbody></table></div>
    <p class="muted">${esc(identities.note)}</p>
    <h2 class="section">Últimos eventos públicos</h2>
    <ul>${feed.events.slice(0, 12).map((event) => `<li>${esc(event.cell)} · ${esc(event.type)} · ${esc(event.summary)}</li>`).join("")}</ul>
    <h2 class="section">Preguntas del jurado</h2>
    ${brief.jury.map((item) => `<article class="card section"><h3>${esc(item.q)}</h3><p>${esc(item.a)}</p></article>`).join("")}
  </section>`;
}

async function view(route) {
  const [name, a, b] = route.parts;
  if (!name) return viewHome();
  if (name === "buscar") return viewSearch(route.params);
  if (name === "maquina") return viewMachine(a, b);
  if (name === "entrar") return viewLogin();
  if (name === "registro") return viewRegister();
  if (name === "confianza") return viewTrust();
  if (name === "arquitectura") return viewArchitecture();
  if (!session) return `<h1>Necesitas una sesión de tu país</h1><p><a href="#/entrar">Entrar</a></p>`;
  if (name === "cuenta") return viewAccount();
  if (name === "publicar") return viewPublish();
  if (name === "maquinas") return viewOwnerMachines();
  if (name === "alquileres") return viewBookings();
  if (name === "alquiler") return viewBooking(a, b);
  if (name === "contrato") return viewContract(a, b);
  return `<h1>Esa página no está en el boceto</h1>`;
}

async function render() {
  const route = parseHash();
  try {
    app.innerHTML = shell(await view(route));
    if (route.path !== lastPath) {
      window.scrollTo(0, 0);
      lastPath = route.path;
    }
  } catch (error) {
    app.innerHTML = shell(`<h1>No se pudo abrir esta vista</h1><p>${esc(error.message)}</p>`);
  }
}

async function login(cell, email, password) {
  const result = await api(`/api/cells/${cell}/auth/login`, { method: "POST", body: { email, password } });
  saveSession({ token: result.token, cell, user: result.user });
  location.hash = "#/cuenta";
  showToast(`Sesión abierta en ${countryOf(cell).name}.`);
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
    if (action === "logout") {
      event.preventDefault();
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
    if (action === "toggle-cell" || action === "toggle-bus") {
      const body = action === "toggle-cell"
        ? { accepting: target.dataset.accepting === "1" }
        : { holdOutbox: target.dataset.hold === "1" };
      await api(`/api/control/${target.dataset.cell}`, { method: "POST", body });
      await render();
      showToast(action === "toggle-cell" ? "Operación de la celda actualizada." : "Bandeja de salida actualizada.");
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
      const next = `#/buscar?${params.toString()}`;
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
        const file = form.querySelector(`[name=file_${paper.key}]`)?.files?.[0]?.name || "";
        if (!file) throw new Error(`Adjunta el archivo de: ${paper.title}.`);
        papers[paper.key] = {
          file,
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
      location.hash = "#/cuenta";
      showToast("Cuenta creada. El expediente quedó en revisión.");
      return;
    }
    if (kind === "review-dossier") {
      const verified = await api(`/api/cells/${session.cell}/me/verify-kyc`, { method: "POST", body: {} });
      const operator = await api(`/api/cells/${session.cell}/me/verify-operator`, { method: "POST", body: {} });
      session.user = operator.id ? operator : verified;
      saveSession(session);
      await render();
      showToast("Expediente revisado. La empresa ya puede alquilar.");
      return;
    }
    if (kind === "kyc") {
      await api(`/api/cells/${session.cell}/me`, { method: "PATCH", body: { kycDoc: data.kycDoc } });
      const verified = await api(`/api/cells/${session.cell}/me/verify-kyc`, { method: "POST", body: {} });
      session.user = verified;
      saveSession(session);
      await render();
      showToast("KYC/KYB verificado en esta celda.");
      return;
    }
    if (kind === "operator") {
      await api(`/api/cells/${session.cell}/me`, { method: "PATCH", body: { operatorCertificate: data.operatorCertificate } });
      const verified = await api(`/api/cells/${session.cell}/me/verify-operator`, { method: "POST", body: {} });
      session.user = verified;
      saveSession(session);
      await render();
      showToast("Certificado de operador verificado.");
      return;
    }
    if (kind === "publish") {
      const created = await api(`/api/cells/${session.cell}/machines`, {
        method: "POST",
        body: { ...data, operatorRequired: Boolean(form.querySelector("[name=operatorRequired]")?.checked) },
      });
      location.hash = "#/cuenta";
      showToast(`Máquina publicada. Propiedad: ${created.machine.ownershipStatus}.`);
      return;
    }
    if (kind === "verify-ownership") {
      await api(`/api/cells/${session.cell}/machines/${form.dataset.id}/verify-ownership`, { method: "POST", body: { ownershipDoc: data.ownershipDoc } });
      await render();
      showToast("Propiedad verificada. El anuncio viaja al índice por el bus.");
      return;
    }
    if (kind === "book") {
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
