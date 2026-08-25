/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const MAX_PNG_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_JSON_SCAN_BYTES = 8 * 1024 * 1024;

function startsWith(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function decodeBase64Json(value) {
  try {
    const binary = atob(value.trim());
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) {
    return null;
  }
}

function pngTextValue(bytes, type, dataStart, dataEnd, separator) {
  if (type === "tEXt") {
    return new TextDecoder("latin1").decode(bytes.subarray(separator + 1, dataEnd));
  }
  let offset = separator + 1;
  if (offset + 2 > dataEnd || bytes[offset] !== 0) return "";
  offset += 2;
  for (let field = 0; field < 2; field += 1) {
    while (offset < dataEnd && bytes[offset] !== 0) offset += 1;
    offset += 1;
  }
  return new TextDecoder().decode(bytes.subarray(offset, dataEnd));
}

async function characterCardPngMetadata(file) {
  const bytes = new Uint8Array(await file.slice(0, MAX_PNG_SCAN_BYTES).arrayBuffer());
  if (!startsWith(bytes, PNG_SIGNATURE)) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    const dataStart = offset + 8;
    const availableEnd = Math.min(dataStart + length, bytes.length);
    if (type === "tEXt" || type === "iTXt") {
      let separator = dataStart;
      while (separator < availableEnd && bytes[separator] !== 0) separator += 1;
      const keyword = ascii(bytes, dataStart, separator);
      if (keyword === "ccv3" || keyword === "chara") {
        const card = decodeBase64Json(pngTextValue(bytes, type, dataStart, availableEnd, separator));
        return { name: String(card?.data?.name || card?.name || sharedFileLabel(file)) };
      }
    }
    if (type === "IDAT" || type === "IEND") return null;
    offset = dataStart + length + 4;
  }
  return null;
}

async function isPawzoPersonaBundle(file) {
  const bytes = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  if (!startsWith(bytes, ZIP_SIGNATURE) || bytes.length < 30) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  if (30 + nameLength + extraLength > bytes.length) return false;
  return ascii(bytes, 30, 30 + nameLength) === "pawzochat.json";
}

function sharedFileLabel(file) {
  const name = String(file?.name || "").trim();
  return name.replace(/\.[^.]+$/, "") || "未命名";
}

function classifyJson(value, fallbackName) {
  if (value && !Array.isArray(value) && typeof value === "object") {
    const spec = String(value.spec || "").toLowerCase();
    if (spec.startsWith("chara_card")) {
      return { kind: "persona", name: String(value.data?.name || value.name || fallbackName) };
    }
    if (value.data && typeof value.data === "object" && typeof value.data.name === "string") {
      return { kind: "persona", name: value.data.name || fallbackName };
    }
    if (Object.hasOwn(value, "entries")) {
      return { kind: "worldbook", name: String(value.name || fallbackName) };
    }
    if (Object.hasOwn(value, "content") && typeof value.name === "string") {
      return { kind: "worldbook", name: value.name || fallbackName };
    }
  }
  if (Array.isArray(value)) return { kind: "worldbook", name: fallbackName };
  return null;
}

async function classifyJsonFile(file) {
  if (file.size > MAX_JSON_SCAN_BYTES) return null;
  try {
    return classifyJson(JSON.parse(await file.text()), sharedFileLabel(file));
  } catch (_) {
    return null;
  }
}

export async function detectSharedImport(payload) {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  if (files.length !== 1) return null;
  const file = files[0];
  const name = String(file.name || "").toLowerCase();
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());

  if (startsWith(header, PNG_SIGNATURE)) {
    const metadata = await characterCardPngMetadata(file);
    return metadata ? { kind: "persona", ...metadata, preview: "image", file } : null;
  }
  if (startsWith(header, ZIP_SIGNATURE)) {
    return await isPawzoPersonaBundle(file)
      ? { kind: "persona", name: sharedFileLabel(file), file }
      : null;
  }
  if (name.endsWith(".json") || file.type === "application/json") {
    const classification = await classifyJsonFile(file);
    return classification ? { ...classification, file } : null;
  }
  return null;
}

export async function importDetectedSharedFile(detected, baseUrl = "") {
  if (!detected?.file || !detected.kind) return { matched: false };
  const endpoint = detected.kind === "persona"
    ? "/api/personas/_import"
    : "/api/worldbooks/_import";
  const formData = new FormData();
  formData.append("file", detected.file);
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, { method: "POST", body: formData });
    const data = await response.json().catch(() => ({}));
    return response.ok
      ? { matched: true, imported: true, kind: detected.kind, data }
      : { matched: true, imported: false, kind: detected.kind, error: data.error || "导入失败" };
  } catch (_) {
    return { matched: true, imported: false, kind: detected.kind, error: "导入请求失败" };
  }
}