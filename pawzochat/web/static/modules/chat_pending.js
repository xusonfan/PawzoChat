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

function toConversationLastMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const first = content.find(block => block && typeof block === "object");
  let text = "";
  if (first?.type === "emoji") text = "[表情]";
  else if (first?.type === "image") text = "[图片]";
  else if (first?.type === "file") text = "[文件]";
  else if (first?.type === "voice") text = "[语音]";
  else text = first?.text || "";
  return {
    role: message?.role || "user",
    text,
    has_image: content.some(block => block?.type === "image"),
    source: message?.source || "web",
    timestamp: message?.timestamp || "",
  };
}

function timestampValue(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function projectPendingConversationSummaries(conversations) {
  const projected = (conversations || []).map(conversation => {
    const pending = pendingByPersona.get(conversation.persona_id) || [];
    if (!pending.length) return conversation;

    const serverTimestamp = timestampValue(
      conversation.last_message?.timestamp || conversation.updated_at,
    );
    const remaining = pending.filter(
      entry => timestampValue(entry.message?.timestamp) > serverTimestamp,
    );
    if (remaining.length) pendingByPersona.set(conversation.persona_id, remaining);
    else {
      pendingByPersona.delete(conversation.persona_id);
      return conversation;
    }

    const latest = remaining[remaining.length - 1].message;
    return {
      ...conversation,
      updated_at: latest.timestamp || conversation.updated_at,
      last_message: toConversationLastMessage(latest),
    };
  });
  return projected.sort((left, right) => {
    const pinOrder = Number(!!right.pinned) - Number(!!left.pinned);
    if (pinOrder) return pinOrder;
    return timestampValue(right.updated_at) - timestampValue(left.updated_at);
  });
}

export function clearPendingUserMessages(personaId) {
  pendingByPersona.delete(personaId);
}