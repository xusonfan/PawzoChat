/*!
 * PawzoChat - offline data repository
 * Copyright (C) 2026 iwyxdxl
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const DB_NAME = "pawzo-offline";
const DB_VERSION = 1;
const RESOURCE_STORE = "resources";
const OUTBOX_STORE = "outbox";
const MAX_RESOURCE_RECORDS = 80;
const OFFLINE_RESOURCE = /^\/api\/(?:conversations(?:\?[^#]*)?|conversations\/[^/?]+\/messages(?:\?[^#]*)?|personas(?:\?[^#]*)?|profile(?:\?[^#]*)?)$/;

function databaseFactory() {
  try { return globalThis.indexedDB || null; } catch (_) { return null; }
}

function openDatabase() {
  const factory = databaseFactory();
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RESOURCE_STORE)) {
        db.createObjectStore(RESOURCE_STORE, { keyPath: "url" });
      }
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        const store = db.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
        store.createIndex("personaId", "personaId", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开离线数据库"));
  });
}

function requestResult(request, message) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(message));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("离线数据库事务失败"));
    transaction.onabort = () => reject(transaction.error || new Error("离线数据库事务已取消"));
  });
}

async function withStore(storeName, mode, operation) {
  const db = await openDatabase();
  if (!db) return null;
  try {
    const transaction = db.transaction(storeName, mode);
    const done = transactionDone(transaction);
    const result = await operation(transaction.objectStore(storeName));
    await done;
    return result;
  } finally {
    db.close();
  }
}

export function isOfflineResource(url) {
  const path = String(url || "").split("#")[0];
  return OFFLINE_RESOURCE.test(path);
}

export async function saveResource(url, data) {
  if (!isOfflineResource(url)) return;
  await withStore(RESOURCE_STORE, "readwrite", async store => {
    store.put({ url, data, updatedAt: Date.now() });
    const records = await requestResult(store.getAll(), "读取离线缓存索引失败");
    records
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(MAX_RESOURCE_RECORDS)
      .forEach(record => store.delete(record.url));
  });
}

export async function loadResource(url) {
  if (!isOfflineResource(url)) return null;
  const record = await withStore(
    RESOURCE_STORE,
    "readonly",
    store => requestResult(store.get(url), "读取离线数据失败"),
  );
  return record ? structuredClone(record.data) : null;
}

function newId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function addOutboxMessage({ personaId, text, quote = "", attachments = [], timestamp }) {
  const record = {
    id: newId(),
    personaId: String(personaId),
    text: String(text || ""),
    quote: String(quote || ""),
    attachments: attachments.map(item => ({
      kind: item.kind === "image" ? "image" : "file",
      name: item.file?.name || "附件",
      type: item.file?.type || "application/octet-stream",
      lastModified: Number(item.file?.lastModified) || Date.now(),
      blob: item.file,
    })),
    createdAt: Date.now(),
    timestamp: timestamp || new Date().toISOString(),
    status: "waiting",
  };
  await withStore(OUTBOX_STORE, "readwrite", store => { store.put(record); });
  window.dispatchEvent(new CustomEvent("pawzo:outbox-changed", { detail: { countDelta: 1 } }));
  return record;
}

export async function listOutboxMessages(personaId = null) {
  const records = await withStore(OUTBOX_STORE, "readonly", store => {
    const request = personaId == null
      ? store.getAll()
      : store.index("personaId").getAll(String(personaId));
    return requestResult(request, "读取待发送消息失败");
  });
  return (records || []).sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeOutboxMessage(id) {
  await withStore(OUTBOX_STORE, "readwrite", store => { store.delete(id); });
  window.dispatchEvent(new CustomEvent("pawzo:outbox-changed"));
}

export async function outboxCount() {
  return Number(await withStore(
    OUTBOX_STORE,
    "readonly",
    store => requestResult(store.count(), "读取 Outbox 数量失败"),
  )) || 0;
}

export function outboxRecordToMessage(record, objectUrlFor = blob => URL.createObjectURL(blob)) {
  const content = [];
  if (record.text) content.push({ type: "text", text: record.text });
  for (const [index, attachment] of (record.attachments || []).entries()) {
    if (attachment.kind === "image") {
      content.push({
        type: "image",
        url: objectUrlFor(attachment.blob, attachment, index),
        offline_blob: true,
      });
    } else {
      content.push({ type: "file", name: attachment.name });
    }
  }
  return {
    role: "user",
    content,
    quote: record.quote || "",
    source: "web",
    timestamp: record.timestamp,
    _outbox_id: record.id,
  };
}

export async function sendOutboxMessage(record) {
  const base = (window.PAWZOCHAT_BASE || "").replace(/\/$/, "");
  const url = `${base}/api/conversations/${encodeURIComponent(record.personaId)}/messages`;
  let response;
  if ((record.attachments || []).length > 0) {
    const body = new FormData();
    body.append("text", record.text || "");
    if (record.quote) body.append("quote", record.quote);
    for (const attachment of record.attachments) {
      const file = new File([attachment.blob], attachment.name, {
        type: attachment.type,
        lastModified: attachment.lastModified,
      });
      body.append(attachment.kind === "image" ? "images" : "files", file);
    }
    response = await fetch(url, { method: "POST", body });
  } else {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record.quote
        ? { text: record.text, quote: record.quote }
        : { text: record.text }),
    });
  }
  let data = {};
  try { data = await response.json(); } catch (_) { /* preserve status-based error */ }
  if (!response.ok) throw new Error(data.error || `发送失败 (${response.status})`);
  await removeOutboxMessage(record.id);
  return data;
}

export async function clearOfflineData() {
  const factory = databaseFactory();
  const deletions = [];
  if (factory) {
    for (const name of [DB_NAME, "pawzo-drafts"]) {
      deletions.push(new Promise(resolve => {
        const request = factory.deleteDatabase(name);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      }));
    }
  }
  if (globalThis.caches) {
    deletions.push(caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith("pawzochat-")).map(key => caches.delete(key)),
    )));
  }
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith("pawzoDraft:")) localStorage.removeItem(key);
    }
  } catch (_) { /* localStorage can be disabled */ }
  await Promise.all(deletions);
}

export async function storageUsage() {
  if (!navigator.storage?.estimate) return { usage: 0, quota: 0 };
  const estimate = await navigator.storage.estimate();
  return {
    usage: Number(estimate.usage) || 0,
    quota: Number(estimate.quota) || 0,
  };
}