/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

const STORAGE_PREFIX = "pawzoDraft:v1";
const DB_NAME = "pawzo-drafts";
const DB_VERSION = 1;
const ATTACHMENT_STORE = "attachments";
const _operations = new Map();

function _draftKey(namespace, scopeId) {
  if (!namespace || scopeId === null || scopeId === undefined || scopeId === "") {
    throw new TypeError("草稿 namespace 和 scopeId 不能为空");
  }
  return `${STORAGE_PREFIX}:${encodeURIComponent(namespace)}:${encodeURIComponent(String(scopeId))}`;
}

function _storage() {
  try {
    return globalThis.localStorage || null;
  } catch (e) {
    return null;
  }
}

function _databaseFactory() {
  try {
    return globalThis.indexedDB || null;
  } catch (e) {
    return null;
  }
}

function _readMetadata(key) {
  const storage = _storage();
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(key) || "null");
    return value && typeof value === "object" ? value : null;
  } catch (e) {
    return null;
  }
}

function _writeMetadata(key, metadata) {
  const storage = _storage();
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(metadata));
  } catch (e) { /* private mode or quota limits must not block editing */ }
}

function _removeMetadata(key) {
  const storage = _storage();
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch (e) { /* storage may be unavailable */ }
}

function _openDatabase() {
  const factory = _databaseFactory();
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(ATTACHMENT_STORE)) return;
      const store = db.createObjectStore(ATTACHMENT_STORE, { keyPath: "id" });
      store.createIndex("draftKey", "draftKey", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开草稿数据库"));
  });
}

function _transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("草稿事务失败"));
    transaction.onabort = () => reject(transaction.error || new Error("草稿事务已取消"));
  });
}

function _recordsForDraft(store, key) {
  const index = store.index("draftKey");
  return new Promise((resolve, reject) => {
    const request = index.getAll(key);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error("读取草稿附件失败"));
  });
}

async function _replaceAttachments(key, attachments) {
  const db = await _openDatabase();
  if (!db) return;
  try {
    const transaction = db.transaction(ATTACHMENT_STORE, "readwrite");
    const done = _transactionDone(transaction);
    const store = transaction.objectStore(ATTACHMENT_STORE);
    const existing = await _recordsForDraft(store, key);
    existing.forEach(record => store.delete(record.id));
    attachments.forEach((attachment, index) => {
      const file = attachment.file;
      store.put({
        id: `${key}:${index}`,
        draftKey: key,
        position: index,
        kind: attachment.kind === "image" ? "image" : "file",
        name: file.name || `attachment-${index + 1}`,
        type: file.type || "application/octet-stream",
        lastModified: Number(file.lastModified) || Date.now(),
        blob: file,
      });
    });
    await done;
  } finally {
    db.close();
  }
}

async function _loadAttachments(key) {
  const db = await _openDatabase();
  if (!db) return [];
  try {
    const transaction = db.transaction(ATTACHMENT_STORE, "readonly");
    const done = _transactionDone(transaction);
    const records = await _recordsForDraft(transaction.objectStore(ATTACHMENT_STORE), key);
    await done;
    return records
      .sort((left, right) => left.position - right.position)
      .map(record => ({
        kind: record.kind,
        file: new File([record.blob], record.name, {
          type: record.type,
          lastModified: record.lastModified,
        }),
      }));
  } finally {
    db.close();
  }
}

function _queue(key, operation) {
  const previous = _operations.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  _operations.set(key, current);
  current.finally(() => {
    if (_operations.get(key) === current) _operations.delete(key);
  }).catch(() => undefined);
  return current;
}

export function getDraftSummary(namespace, scopeId) {
  const metadata = _readMetadata(_draftKey(namespace, scopeId));
  if (!metadata) return null;
  const text = typeof metadata.text === "string" ? metadata.text : "";
  const quote = typeof metadata.quote === "string" ? metadata.quote : "";
  const attachmentCount = Math.max(0, Number(metadata.attachmentCount) || 0);
  if (!text.trim() && !quote.trim() && attachmentCount === 0) return null;
  return {
    text,
    quote,
    attachmentCount,
    attachmentNames: Array.isArray(metadata.attachmentNames) ? metadata.attachmentNames : [],
    updatedAt: Number(metadata.updatedAt) || 0,
  };
}

export async function loadDraft(namespace, scopeId) {
  const key = _draftKey(namespace, scopeId);
  const pending = _operations.get(key);
  if (pending) await pending.catch(() => undefined);
  const summary = getDraftSummary(namespace, scopeId);
  if (!summary) return null;
  let attachments = [];
  try {
    attachments = await _loadAttachments(key);
  } catch (e) { /* text and quote remain recoverable when IndexedDB fails */ }
  return { ...summary, attachments };
}

export function saveDraftMetadata(namespace, scopeId, draft) {
  const key = _draftKey(namespace, scopeId);
  const current = _readMetadata(key) || {};
  const attachments = Array.isArray(draft?.attachments) ? draft.attachments : null;
  const attachmentNames = attachments
    ? attachments.map(item => item?.file?.name || "附件")
    : (Array.isArray(current.attachmentNames) ? current.attachmentNames : []);
  const metadata = {
    text: String(draft?.text || ""),
    quote: String(draft?.quote || ""),
    attachmentCount: attachments
      ? attachments.length
      : Math.max(0, Number(current.attachmentCount) || 0),
    attachmentNames,
    updatedAt: Date.now(),
  };
  if (!metadata.text.trim() && !metadata.quote.trim() && metadata.attachmentCount === 0) {
    _removeMetadata(key);
  } else {
    _writeMetadata(key, metadata);
  }
}

export function saveDraft(namespace, scopeId, draft) {
  const key = _draftKey(namespace, scopeId);
  const attachments = Array.isArray(draft?.attachments)
    ? draft.attachments.filter(item => item?.file instanceof Blob)
    : [];
  const metadata = {
    text: String(draft?.text || ""),
    quote: String(draft?.quote || ""),
    attachmentCount: attachments.length,
    attachmentNames: attachments.map(item => item.file.name || "附件"),
    updatedAt: Date.now(),
  };
  const hasContent = metadata.text.trim() || metadata.quote.trim() || attachments.length > 0;
  if (!hasContent) return clearDraft(namespace, scopeId);

  _writeMetadata(key, metadata);
  return _queue(key, () => _replaceAttachments(key, attachments));
}

export function clearDraft(namespace, scopeId) {
  const key = _draftKey(namespace, scopeId);
  _removeMetadata(key);
  return _queue(key, () => _replaceAttachments(key, []));
}