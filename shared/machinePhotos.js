import { HttpError } from "./http.js";

const IMAGE_MIME = /^(image\/(png|jpeg|jpg|webp|gif))$/i;

export function normalizeMachinePhotos(input, { required = true } = {}) {
  const list = Array.isArray(input) ? input : [];
  if (required && list.length < 1) {
    throw new HttpError(400, "Sube al menos una foto de la máquina.", "photos_required");
  }
  if (list.length > 4) throw new HttpError(400, "Puedes subir hasta 4 fotos.", "photos_limit");
  return list.map((item, index) => {
    const file = String(item?.file || `foto-${index + 1}.jpg`).trim();
    const mime = String(item?.mime || "image/jpeg").trim();
    const content = String(item?.content || "").trim();
    if (!IMAGE_MIME.test(mime)) throw new HttpError(400, `La foto ${index + 1} debe ser una imagen.`, "photo_mime");
    let bytes = 0;
    try {
      bytes = Buffer.from(content, "base64").length;
    } catch {
      throw new HttpError(400, `No se pudo leer la foto ${index + 1}.`, "photo_content");
    }
    if (bytes < 40 || bytes > 350_000) {
      throw new HttpError(400, `La foto ${index + 1} debe pesar menos de 350 KB.`, "photo_size");
    }
    return { file, mime, content };
  });
}

export function parseMachinePhotos(raw) {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function photoMeta(photos, cell, machineId) {
  const count = photos.length;
  return {
    photoCount: count,
    hasPhotos: count > 0,
    photoUrl: count > 0 ? `/api/cells/${cell}/machines/${machineId}/photo/0` : null,
    photos: photos.map((photo, index) => ({
      file: photo.file,
      mime: photo.mime,
      url: `/api/cells/${cell}/machines/${machineId}/photo/${index}`,
    })),
  };
}
