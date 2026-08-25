/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

const DB_NAME = "pawzo-share-targets";
const DB_VERSION = 1;
const PAYLOAD_STORE = "payloads";
const RECENT_FORWARD_KEY = "pawzoRecentForwardPersonas:v1";
const MAX_PAYLOAD_AGE_MS = 24 * 60 * 60 * 1000;

function localStorageValue() {
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    return null;
  }
}

function recentForwardIds() {
  const storage = localStorageValue();
  if (!storage) return [];
  try {
    const ids = JSON.parse(storage.getItem(RECENT_FORWARD_KEY) || "[]");
    return Array.isArray(ids) ? ids.filter(id => typeof id === "string" && id) : [];
  } catch (_) {
    return [];
  }
}

export function recentForwardPersonas(personas, limit = 6) {
  const personaById = new Map((personas || []).map(persona => [persona.id, persona]));
  return recentForwardIds()
    .map(id => personaById.get(id))
    .filter(Boolean)
    .slice(0, Math.max(0, Number(limit) || 0));
}

export function rememberForwardPersona(personaId, limit = 12) {
  if (!personaId) return;
  const storage = localStorageValue();
  if (!storage) return;
  const ids = [String(personaId), ...recentForwardIds().filter(id => id !== String(personaId))]
    .slice(0, Math.max(1, Number(limit) || 1));
  try {
    storage.setItem(RECENT_FORWARD_KEY, JSON.stringify(ids));
  } catch (_) { /* private mode or quota policy must not block sharing */ }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PAYLOAD_STORE)) {
        db.createObjectStore(PAYLOAD_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开分享暂存区"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("分享暂存区事务失败"));
    transaction.onabort = transaction.onerror;
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("无法读取分享内容"));
  });
}

export function recentSharedPersonas(personas, conversations, limit = 6) {
  const personaById = new Map((personas || []).map(persona => [persona.id, persona]));
  return [...(conversations || [])]
    .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")))
    .map(conversation => personaById.get(conversation.persona_id))
    .filter(Boolean)
    .slice(0, Math.max(0, Number(limit) || 0));
}

export function sharedPayloadText(payload) {
  return [payload?.title, payload?.text, payload?.url]
    .map(value => String(value || "").trim())
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join("\n");
}

export async function readSharedPayload(id) {
  if (!id) return null;
  const db = await openDatabase();
  try {
    const transaction = db.transaction(PAYLOAD_STORE, "readonly");
    const payload = await requestResult(transaction.objectStore(PAYLOAD_STORE).get(id));
    await transactionDone(transaction);
    if (!payload || Date.now() - Number(payload.createdAt || 0) > MAX_PAYLOAD_AGE_MS) return null;
    return {
      id: payload.id,
      text: sharedPayloadText(payload),
      files: Array.isArray(payload.files) ? payload.files.filter(file => file instanceof Blob) : [],
    };
  } finally {
    db.close();
  }
}

export async function deleteSharedPayload(id) {
  if (!id) return;
  const db = await openDatabase();
  try {
    const transaction = db.transaction(PAYLOAD_STORE, "readwrite");
    transaction.objectStore(PAYLOAD_STORE).delete(id);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}