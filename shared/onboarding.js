import { HttpError } from "./http.js";

export const ONBOARDING = {
  CO: {
    taxLabel: "NIT",
    taxPlaceholder: "900.123.456-7",
    legalForms: ["S.A.S.", "S.A.", "Ltda.", "Persona natural comerciante"],
    papers: [
      { key: "existence", title: "Certificado de existencia y representación legal", detail: "Cámara de Comercio. Debe estar expedido hace menos de 30 días." },
      { key: "taxRegistration", title: "RUT", detail: "Registro Único Tributario de la DIAN, con la actividad de la empresa." },
      { key: "representativeId", title: "Cédula del representante legal", detail: "Documento de identidad por ambas caras." },
      { key: "insurance", title: "Póliza de responsabilidad civil", detail: "Debe estar vigente y cubrir la operación de maquinaria.", needsPolicy: true },
      { key: "operator", title: "Certificado del operador", detail: "Competencia o licencia de quien va a operar el equipo.", needsReference: true },
    ],
  },
  US: {
    taxLabel: "EIN",
    taxPlaceholder: "12-3456789",
    legalForms: ["LLC", "Corporation", "Partnership"],
    papers: [
      { key: "existence", title: "Certificate of formation", detail: "Articles of organization o certificado de constitución de la empresa." },
      { key: "taxRegistration", title: "Form W-9", detail: "Formulario de identificación fiscal del IRS." },
      { key: "representativeId", title: "Identificación de quien firma", detail: "Licencia o pasaporte del representante autorizado." },
      { key: "insurance", title: "Certificate of insurance", detail: "Responsabilidad civil general vigente (COI).", needsPolicy: true },
      { key: "operator", title: "Habilitación del operador", detail: "Tarjeta de operador competente o formación OSHA del equipo.", needsReference: true },
    ],
  },
  BR: {
    taxLabel: "CNPJ",
    taxPlaceholder: "12.345.678/0001-90",
    legalForms: ["Ltda.", "S.A."],
    papers: [
      { key: "existence", title: "Certidão da Junta Comercial", detail: "Contrato social o certidão de breve relato vigente." },
      { key: "taxRegistration", title: "Cartão CNPJ", detail: "Comprovante de inscrição na Receita Federal." },
      { key: "representativeId", title: "Documento do responsável", detail: "RG ou CNH de quem representa a empresa." },
      { key: "insurance", title: "Apólice de responsabilidade civil", detail: "Seguro vigente para operação de máquinas.", needsPolicy: true },
      { key: "operator", title: "Certificado do operador", detail: "Habilitação conforme a NR-12 para o equipamento.", needsReference: true },
    ],
  },
  DE: {
    taxLabel: "Handelsregisternummer",
    taxPlaceholder: "HRB 123456",
    legalForms: ["GmbH", "UG", "AG"],
    papers: [
      { key: "existence", title: "Handelsregisterauszug", detail: "Extracto del registro mercantil, reciente." },
      { key: "taxRegistration", title: "Gewerbeanmeldung", detail: "Alta de la actividad ante la autoridad local." },
      { key: "representativeId", title: "Documento del Geschäftsführer", detail: "Documento de identidad de quien representa la sociedad." },
      { key: "insurance", title: "Betriebshaftpflicht", detail: "Seguro de responsabilidad civil de la empresa, vigente.", needsPolicy: true },
      { key: "operator", title: "Befähigungsnachweis", detail: "Acreditación de quien opera el equipo.", needsReference: true },
    ],
  },
  FR: {
    taxLabel: "SIREN",
    taxPlaceholder: "123 456 789",
    legalForms: ["SAS", "SARL", "SA"],
    papers: [
      { key: "existence", title: "Extrait Kbis", detail: "Extracto del registro de comercio, de menos de 3 meses." },
      { key: "taxRegistration", title: "Avis de situation SIRENE", detail: "Situación de la empresa en el repertorio SIRENE." },
      { key: "representativeId", title: "Documento del representante", detail: "Documento de identidad de quien representa la sociedad." },
      { key: "insurance", title: "Attestation d'assurance RC", detail: "Responsabilidad civil vigente para la obra y la máquina.", needsPolicy: true },
      { key: "operator", title: "CACES del operador", detail: "Habilitación del operador para la categoría del equipo.", needsReference: true },
    ],
  },
};

function clean(value) {
  return String(value || "").trim();
}

export function assertDossier(cell, input) {
  const pack = ONBOARDING[cell];
  if (!pack) throw new HttpError(400, "Ese país no tiene alta de empresas.", "unknown_cell");
  if (!input || typeof input !== "object") throw new HttpError(400, "Falta el expediente de la empresa.", "dossier");
  const representativeName = clean(input.representativeName);
  const representativeId = clean(input.representativeId);
  const legalForm = clean(input.legalForm);
  const tradeName = clean(input.tradeName);
  if (representativeName.length < 5) throw new HttpError(400, "Indica el nombre completo del representante legal.", "representative");
  if (representativeId.length < 5) throw new HttpError(400, "Indica el número de documento del representante legal.", "representative_id");
  if (!pack.legalForms.includes(legalForm)) throw new HttpError(400, "Elige el tipo de sociedad de la empresa.", "legal_form");
  const source = input.papers && typeof input.papers === "object" ? input.papers : {};
  const papers = {};
  for (const paper of pack.papers) {
    const raw = source[paper.key] || {};
    const file = clean(raw.file);
    const reference = clean(raw.reference);
    const insurer = clean(raw.insurer);
    const expires = clean(raw.expires);
    if (file.length < 3) throw new HttpError(400, `Adjunta el archivo de: ${paper.title}.`, "dossier_file");
    if (paper.needsReference && reference.length < 4) throw new HttpError(400, `Indica el número de: ${paper.title}.`, "dossier_ref");
    if (paper.needsPolicy) {
      if (reference.length < 4) throw new HttpError(400, "Indica el número de la póliza.", "policy");
      if (insurer.length < 2) throw new HttpError(400, "Indica la aseguradora.", "insurer");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new HttpError(400, "Indica hasta cuándo está vigente la póliza.", "insurance_expiry");
    }
    papers[paper.key] = {
      title: paper.title,
      file,
      reference: reference || null,
      insurer: insurer || null,
      expires: expires || null,
    };
  }
  return {
    tradeName: tradeName || null,
    legalForm,
    representativeName,
    representativeId,
    papers,
    kycDoc: representativeId,
    operatorCertificate: papers.operator.reference || papers.operator.file,
  };
}
