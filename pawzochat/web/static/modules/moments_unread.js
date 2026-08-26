const STORAGE_KEY = "pawzochat.moments.last_read_at";
const MAX_UNREAD_AUTHORS = 3;

let _authors = [];
const _listeners = new Set();

function _readLastReadAt(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(STORAGE_KEY) || "";
  } catch (_) {
    return "";
  }
}

function _writeLastReadAt(timestamp, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, timestamp);
  } catch (_) {
    // Unread hints are optional when storage is unavailable.
  }
}

function _emit() {
  const snapshot = getMomentsUnreadAuthors();
  for (const listener of _listeners) listener(snapshot);
}

function _setAuthors(authors) {
  _authors = (authors || []).slice(0, MAX_UNREAD_AUTHORS);
  _emit();
}

export function unreadMomentAuthors(moments, lastReadAt, limit = MAX_UNREAD_AUTHORS) {
  const lastReadTime = Date.parse(lastReadAt || "");
  if (!Number.isFinite(lastReadTime)) return [];
  const seen = new Set();
  const authors = [];
  for (const moment of moments || []) {
    const author = moment?.author;
    if (!author || author === "user" || seen.has(author)) continue;
    const publishedTime = Date.parse(moment.timestamp || "");
    if (!Number.isFinite(publishedTime) || publishedTime <= lastReadTime) continue;
    seen.add(author);
    authors.push({
      author,
      authorLabel: moment.author_label || author,
      timestamp: moment.timestamp,
    });
    if (authors.length >= limit) break;
  }
  return authors;
}

export function getMomentsUnreadAuthors() {
  return _authors.map(item => ({ ...item }));
}

export function subscribeMomentsUnread(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

export async function initMomentsUnread(apiClient, storage = globalThis.localStorage) {
  try {
    const result = await apiClient.get("/api/moments?limit=100");
    const moments = result.moments || [];
    const lastReadAt = _readLastReadAt(storage);
    if (!lastReadAt) {
      _writeLastReadAt(moments[0]?.timestamp || new Date().toISOString(), storage);
      _setAuthors([]);
      return;
    }
    _setAuthors(unreadMomentAuthors(moments, lastReadAt));
  } catch (_) {
    // Keep the last in-memory hint when startup synchronization fails.
  }
}

export async function recordUnreadMoment(
  apiClient,
  momentId,
  { isViewing = false, storage = globalThis.localStorage } = {},
) {
  if (!momentId) return;
  try {
    const result = await apiClient.get(`/api/moments/${encodeURIComponent(momentId)}`);
    const moment = result.moment;
    if (!moment?.timestamp) return;
    if (isViewing) {
      markMomentsRead(moment.timestamp, storage);
      return;
    }
    if (!moment.author || moment.author === "user") return;
    const lastReadAt = _readLastReadAt(storage);
    if (lastReadAt && unreadMomentAuthors([moment], lastReadAt, 1).length === 0) return;
    const next = [
      {
        author: moment.author,
        authorLabel: moment.author_label || moment.author,
        timestamp: moment.timestamp,
      },
      ..._authors.filter(item => item.author !== moment.author),
    ];
    _setAuthors(next);
  } catch (_) {
    // SSE will be followed by startup synchronization after a reconnect/reload.
  }
}

export function markMomentsRead(timestamp = new Date().toISOString(), storage = globalThis.localStorage) {
  _writeLastReadAt(timestamp, storage);
  _setAuthors([]);
}