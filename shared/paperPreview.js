function pdfSafe(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[()\\]/g, " ")
    .replace(/[^\x20-\x7E]/g, "?")
    .slice(0, 90);
}

export function buildSimplePdf(lines) {
  const content = [
    "BT",
    "/F1 14 Tf",
    "50 740 Td",
    ...lines.flatMap((line, index) => {
      const text = `(${pdfSafe(line)}) Tj`;
      return index === 0 ? [text] : ["0 -22 Td", text];
    }),
    "ET",
  ].join("\n");
  const objects = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n",
    `4 0 obj<< /Length ${Buffer.byteLength(content, "utf8")} >>stream\n${content}\nendstream\nendobj\n`,
    "5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += object;
  }
  const startxref = Buffer.byteLength(body, "utf8");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF`;
  return Buffer.from(body, "utf8");
}

export function paperDocument(company, paperKey, paper) {
  const title = paper?.title || paperKey;
  const lines = [
    "MaquiRent · expediente de la filial",
    title,
    "",
    `Empresa: ${company.legalName || ""}`,
    `NIT / ID: ${company.taxId || ""}`,
    `Ciudad: ${company.city || ""}`,
    `Correo: ${company.email || ""}`,
    `Representante: ${company.representativeName || ""}`,
    `Documento: ${company.representativeId || ""}`,
    "",
    `Archivo: ${paper?.file || ""}`,
  ];
  if (paper?.reference) lines.push(`Referencia: ${paper.reference}`);
  if (paper?.insurer) lines.push(`Aseguradora: ${paper.insurer}`);
  if (paper?.expires) lines.push(`Vigente hasta: ${paper.expires}`);
  lines.push("", "Documento de demostracion para revision de la filial.");
  return {
    file: paper?.file || `${paperKey}.pdf`,
    mime: "application/pdf",
    content: buildSimplePdf(lines).toString("base64"),
    generated: true,
    title,
  };
}

export function ownershipDocument(machine, owner) {
  const lines = [
    "MaquiRent · factura o registro del equipo",
    machine.title || "Maquina",
    "",
    `Propietario: ${owner?.legal_name || owner?.legalName || ""}`,
    `Correo: ${owner?.email || ""}`,
    `Ciudad: ${machine.city || ""}`,
    `Marca: ${machine.brand || ""}`,
    `Modelo: ${machine.model || ""}`,
    `Anio: ${machine.year || ""}`,
    "",
    `Referencia: ${machine.ownership_doc || machine.ownershipDoc || ""}`,
    "",
    "Documento de demostracion para revision de propiedad.",
  ];
  return {
    file: `${machine.ownership_doc || machine.ownershipDoc || "factura"}.pdf`,
    mime: "application/pdf",
    content: buildSimplePdf(lines).toString("base64"),
    generated: true,
    title: "Factura o registro del equipo",
  };
}

export function decodePaperContent(paper) {
  if (!paper?.content) return null;
  const mime = String(paper.mime || "application/pdf");
  if (!/^(application\/pdf|image\/(png|jpeg|jpg|webp|gif))$/i.test(mime)) return null;
  try {
    const buffer = Buffer.from(String(paper.content), "base64");
    if (!buffer.length || buffer.length > 400_000) return null;
    return { file: paper.file, mime, content: buffer.toString("base64"), generated: false, title: paper.title };
  } catch {
    return null;
  }
}
