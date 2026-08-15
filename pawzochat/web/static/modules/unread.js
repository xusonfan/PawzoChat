/* PawzoChat unread-count helpers.
 *
 * Unread values live on conversation objects in app state. DOM badges are a
 * projection: only mutate them when the displayed count actually changes, so
 * list/SSE refreshes do not remove-and-recreate identical badges (flash).
 */

export function normalizeUnreadCount(count) {
  return Math.max(0, Number(count) || 0);
}

export function formatUnreadCount(count) {
  const value = normalizeUnreadCount(count);
  return value > 99 ? "99+" : String(value);
}

export function totalUnread(conversations) {
  return (conversations || []).reduce(
    (sum, conversation) => sum + normalizeUnreadCount(conversation.unread_count),
    0,
  );
}

export function unreadBadgeHtml(count, className = "unread-badge") {
  const value = normalizeUnreadCount(count);
  if (!value) return "";
  const label = `${value} 条未读消息`;
  return `<span class="${className}" data-count="${value}" role="status" aria-label="${label}">${formatUnreadCount(value)}</span>`;
}

export function readBadgeCount(badgeEl) {
  if (!badgeEl) return 0;
  if (badgeEl.dataset && badgeEl.dataset.count != null && badgeEl.dataset.count !== "") {
    return normalizeUnreadCount(badgeEl.dataset.count);
  }
  const text = (badgeEl.textContent || "").trim();
  if (text === "99+") return 100;
  return normalizeUnreadCount(text);
}

export function markConversationReadLocal(conversations, personaId) {
  const conversation = (conversations || []).find(item => item.persona_id === personaId);
  if (!conversation) return false;
  conversation.unread_count = 0;
  return true;
}

/** Merge server list into previous state: keep last known unread until server provides a number. */
export function mergeConversationsPreserveUnread(previous, incoming) {
  const prevById = new Map((previous || []).map(c => [c.persona_id, c]));
  return (incoming || []).map(item => {
    const next = { ...item };
    if (next.unread_count == null || next.unread_count === "") {
      const prev = prevById.get(next.persona_id);
      next.unread_count = prev ? normalizeUnreadCount(prev.unread_count) : 0;
    } else {
      next.unread_count = normalizeUnreadCount(next.unread_count);
    }
    return next;
  });
}

export function setConversationUnreadBadge(wrap, count) {
  if (!wrap) return false;
  const value = normalizeUnreadCount(count);
  const existing = wrap.querySelector(".conv-unread-badge");
  if (readBadgeCount(existing) === value) return false;
  if (!value) {
    existing?.remove();
    return true;
  }
  if (existing) {
    existing.dataset.count = String(value);
    existing.setAttribute("aria-label", `${value} 条未读消息`);
    existing.textContent = formatUnreadCount(value);
    return true;
  }
  wrap.insertAdjacentHTML("beforeend", unreadBadgeHtml(value, "conv-unread-badge"));
  return true;
}

export function updateConversationUnread(conversations) {
  let changed = false;
  for (const conversation of conversations || []) {
    const item = Array.from(document.querySelectorAll(".conv-item[data-persona-id]"))
      .find(el => el.dataset.personaId === conversation.persona_id);
    const wrap = item?.querySelector(".conv-avatar-wrap");
    if (setConversationUnreadBadge(wrap, conversation.unread_count)) changed = true;
  }
  return changed;
}

export function updateChatTabUnread(conversations) {
  const count = totalUnread(conversations);
  let changed = false;
  document.querySelectorAll(".tab[data-tab='chat']").forEach(tab => {
    const existing = tab.querySelector(".tab-unread-badge");
    if (readBadgeCount(existing) === count) {
      if (!count) tab.removeAttribute("aria-label");
      else tab.setAttribute("aria-label", `聊天，${count} 条未读消息`);
      return;
    }
    changed = true;
    if (!count) {
      existing?.remove();
      tab.removeAttribute("aria-label");
      return;
    }
    tab.setAttribute("aria-label", `聊天，${count} 条未读消息`);
    if (existing) {
      existing.dataset.count = String(count);
      existing.setAttribute("aria-hidden", "true");
      existing.textContent = formatUnreadCount(count);
      return;
    }
    const badge = document.createElement("span");
    badge.className = "tab-unread-badge";
    badge.dataset.count = String(count);
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = formatUnreadCount(count);
    tab.appendChild(badge);
  });
  return changed;
}