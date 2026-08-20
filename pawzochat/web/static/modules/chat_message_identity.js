/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

export function messageSequence(message) {
  const sequence = message?._seq;
  return Number.isInteger(sequence) && sequence > 0 ? String(sequence) : "";
}

export function mergeMessagesBySequence(current, incoming) {
  const bySequence = new Map();
  const withoutSequence = [];
  for (const message of [...(current || []), ...(incoming || [])]) {
    const sequence = messageSequence(message);
    if (sequence) bySequence.set(sequence, message);
    else withoutSequence.push(message);
  }
  return [
    ...bySequence.values(),
    ...withoutSequence,
  ].sort((left, right) => {
    const leftSequence = Number(messageSequence(left)) || Number.MAX_SAFE_INTEGER;
    const rightSequence = Number(messageSequence(right)) || Number.MAX_SAFE_INTEGER;
    return leftSequence - rightSequence;
  });
}

export function hasRenderedMessage(container, message) {
  const sequence = messageSequence(message);
  if (!sequence || !container) return false;
  return Array.from(
    container.querySelectorAll(".msg-row[data-message-seq]"),
  ).some(row => row.dataset.messageSeq === sequence);
}