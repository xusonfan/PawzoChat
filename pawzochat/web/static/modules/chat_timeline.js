/* PawzoChat — Copyright (C) 2026 iwyxdxl. SPDX-License-Identifier: AGPL-3.0-or-later */
/* Message state shared by pagination, optimistic sends and live events. */
export class ChatTimeline {
  constructor() {
    this.byKey = new Map();
    this.items = [];
    this.ownKeys = new Set();
  }

  merge(messages) {
    const added = [];
    for (const message of messages) {
      const key = message.local_id || message._page_key;
      if (!key) continue;
      const previous = this.byKey.get(key);
      const next = { ...previous, ...message, _key: key };
      if (Number.isInteger(next._position)) { delete next._pending; delete next._failed; }
      // An SSE message may arrive after its paginated representation. Keep
      // its position, and don't recreate an unchanged mounted bubble.
      if (!previous) added.push(next);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) this.byKey.set(key, next);
    }
    this.reorder();
    return added.filter(message => !this.ownKeys.has(message._key));
  }

  reorder() {
    this.items = [...this.byKey.values()].sort((a, b) => {
      const ap = Number.isInteger(a._position), bp = Number.isInteger(b._position);
      if (ap && bp) return a._position - b._position;
      if (ap !== bp) return ap ? -1 : 1;
      return 0; // SSE/queued messages keep arrival order until storage assigns a position.
    });
  }

  optimistic(message) {
    this.ownKeys.add(message.local_id);
    this.merge([message]);
    return message.local_id;
  }

  acknowledge(temporaryKey, message) {
    // Queued messages have no stored position yet. Replace the key in its
    // original slot so POST acknowledgements cannot reorder rapid sends.
    if (message?.local_id && this.byKey.has(temporaryKey) && !this.byKey.has(message.local_id)) {
      this.byKey = new Map([...this.byKey].map(([key, value]) => key === temporaryKey
        ? [message.local_id, { ...message, _key: message.local_id }]
        : [key, value]));
    } else this.byKey.delete(temporaryKey);
    this.ownKeys.delete(temporaryKey);
    if (message?.local_id) {
      this.ownKeys.add(message.local_id);
      this.merge([message]);
    } else this.reorder();
  }

  fail(key) {
    const message = this.byKey.get(key);
    if (message) this.byKey.set(key, { ...message, _failed: true });
    this.reorder();
  }
}
