/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

const pendingByPersona = new Map();
let nextPendingId = 1;

function messageFingerprint(message) {
  return JSON.stringify({
    role: message?.role || "",
    content: message?.content || [],
    source: message?.source || "",
    timestamp: message?.timestamp || "",
    quote: message?.quote || "",
  });
}

export function addPendingUserMessage(personaId, message) {
  const entry = { id: nextPendingId++, message };
  const pending = pendingByPersona.get(personaId) || [];
  pendingByPersona.set(personaId, [...pending, entry]);
  return entry.id;
}

export function confirmPendingUserMessage(personaId, pendingId, message) {
  const pending = pendingByPersona.get(personaId);
  const entry = pending?.find(item => item.id === pendingId);
  if (entry && message) entry.message = message;
}

export function removePendingUserMessage(personaId, pendingId) {
  const pending = pendingByPersona.get(personaId) || [];
  const remaining = pending.filter(item => item.id !== pendingId);
  if (remaining.length) pendingByPersona.set(personaId, remaining);
  else pendingByPersona.delete(personaId);
}

export function mergePendingUserMessages(personaId, serverMessages) {
  const pending = pendingByPersona.get(personaId) || [];
  if (!pending.length) return serverMessages;

  const serverFingerprints = new Set(serverMessages.map(messageFingerprint));
  const remaining = pending.filter(
    entry => !serverFingerprints.has(messageFingerprint(entry.message)),
  );

  if (remaining.length) pendingByPersona.set(personaId, remaining);
  else pendingByPersona.delete(personaId);

  return [...serverMessages, ...remaining.map(entry => entry.message)];
}

export function clearPendingUserMessages(personaId) {
  pendingByPersona.delete(personaId);
}