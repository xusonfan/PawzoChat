/* Conversation-list context menu: touch long-press, mouse context menu and keyboard. */

const LONG_PRESS_MS = 500;
const MOVE_CANCEL_PX = 10;
const VIEWPORT_GAP = 8;

let activeMenu = null;
let activeCleanup = null;

export function longPressMoved(startX, startY, x, y) {
  return Math.abs(x - startX) > MOVE_CANCEL_PX
    || Math.abs(y - startY) > MOVE_CANCEL_PX;
}

export function clampMenuPosition(x, y, width, height, viewportWidth, viewportHeight) {
  return {
    left: Math.max(VIEWPORT_GAP, Math.min(x, viewportWidth - width - VIEWPORT_GAP)),
    top: Math.max(VIEWPORT_GAP, Math.min(y, viewportHeight - height - VIEWPORT_GAP)),
  };
}

export function conversationMenuLabels(pinned) {
  return [pinned ? "取消置顶" : "置顶对话", "不显示聊天"];
}

export function conversationMenuAction(index, pinned) {
  return index === 0
    ? { type: "pin", pinned: !pinned }
    : { type: "hide" };
}

export function createLongPressTracker({
  onLongPress,
  delay = LONG_PRESS_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let pending = null;
  let suppressedTarget = null;
  const cancel = () => {
    if (pending?.timer != null) clearTimer(pending.timer);
    pending = null;
  };
  return {
    beginInput() {
      // A synthetic click generated after pointerup has no new pointerdown.
      // Any pointerdown therefore starts an independent gesture and must clear
      // suppression left behind when a browser emitted no trailing click.
      suppressedTarget = null;
    },
    start(target, x, y, payload) {
      cancel();
      const current = { target, x, y, payload, timer: null };
      current.timer = setTimer(() => {
        if (pending !== current) return;
        pending = null;
        suppressedTarget = target;
        onLongPress(current);
      }, delay);
      pending = current;
    },
    move(x, y) {
      if (pending && longPressMoved(pending.x, pending.y, x, y)) cancel();
    },
    cancel,
    consumeClick(target) {
      if (target !== suppressedTarget) return false;
      suppressedTarget = null;
      return true;
    },
    get pending() { return !!pending; },
  };
}

export function clearConversationSelection(row, selection = null) {
  const currentSelection = selection
    ?? globalThis.window?.getSelection?.()
    ?? globalThis.document?.getSelection?.();
  if (!row || !currentSelection || currentSelection.rangeCount === 0) return false;

  let intersectsRow = row.contains?.(currentSelection.anchorNode)
    || row.contains?.(currentSelection.focusNode);
  for (let index = 0; !intersectsRow && index < currentSelection.rangeCount; index += 1) {
    const range = currentSelection.getRangeAt?.(index);
    try {
      intersectsRow = !!range?.intersectsNode?.(row);
    } catch {
      // A stale browser selection may reference a detached node.
    }
  }
  if (!intersectsRow) return false;
  currentSelection.removeAllRanges();
  return true;
}

export function closeConversationMenu({ restoreFocus = false } = {}) {
  if (!activeMenu) return;
  const trigger = activeMenu._trigger;
  activeCleanup?.();
  activeMenu.remove();
  activeMenu = null;
  activeCleanup = null;
  if (restoreFocus && trigger?.isConnected) trigger.focus();
}

function openConversationMenu(row, conversation, point, actions, { clearSelection = false } = {}) {
  closeConversationMenu();
  const labels = conversationMenuLabels(!!conversation.pinned);
  const menu = document.createElement("div");
  menu.className = "conversation-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "对话操作");
  menu.innerHTML = labels.map((label, index) => (
    `<button type="button" role="menuitem" data-menu-index="${index}" aria-label="${label}">${label}</button>`
  )).join("");
  menu._trigger = row;
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const position = clampMenuPosition(
    point.x, point.y, rect.width, rect.height, window.innerWidth, window.innerHeight,
  );
  menu.style.left = `${position.left}px`;
  menu.style.top = `${position.top}px`;

  const run = async index => {
    closeConversationMenu();
    const action = conversationMenuAction(index, !!conversation.pinned);
    if (action.type === "pin") await actions.onPin(conversation, action.pinned);
    else await actions.onHide(conversation);
  };
  const onMenuClick = event => {
    const item = event.target.closest("[role='menuitem']");
    if (!item) return;
    event.stopPropagation();
    run(Number(item.dataset.menuIndex));
  };
  const onOutside = event => {
    if (activeMenu && !activeMenu.contains(event.target)) closeConversationMenu();
  };
  const onKey = event => {
    if (!activeMenu) return;
    const items = [...activeMenu.querySelectorAll("[role='menuitem']")];
    const index = items.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      closeConversationMenu({ restoreFocus: true });
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      items[(index + delta + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    }
  };
  menu.addEventListener("click", onMenuClick);
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("click", onOutside, true);
  document.addEventListener("keydown", onKey);
  window.addEventListener("popstate", closeConversationMenu);
  window.addEventListener("pagehide", closeConversationMenu);
  activeMenu = menu;
  activeCleanup = () => {
    menu.removeEventListener("click", onMenuClick);
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("click", onOutside, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("popstate", closeConversationMenu);
    window.removeEventListener("pagehide", closeConversationMenu);
  };
  // Some mobile engines create a native selection before CSS suppression takes
  // effect. Clear it only after this row's long-press menu has actually opened.
  if (clearSelection) clearConversationSelection(row);
  menu.querySelector("[role='menuitem']")?.focus();
}

export function attachConversationMenu(list, conversations, actions, longPressTiming = {}) {
  if (!list) return () => {};
  const byId = new Map(conversations.map(item => [item.persona_id, item]));
  const tracker = createLongPressTracker({
    ...longPressTiming,
    onLongPress: current => {
      const { row, conversation } = current.payload;
      openConversationMenu(
        row, conversation, { x: current.x, y: current.y }, actions,
        { clearSelection: true },
      );
    },
  });

  const cancelGesture = () => tracker.cancel();
  const rowFrom = target => target?.closest?.(".conv-item[data-persona-id]");
  const conversationFor = row => row ? byId.get(row.dataset.personaId) : null;

  const onSelectStart = event => {
    if (!rowFrom(event.target)) return;
    event.preventDefault();
  };
  const onDragStart = event => {
    const row = rowFrom(event.target);
    if (!row || !event.target?.closest?.("img")) return;
    event.preventDefault();
  };
  const onPointerDown = event => {
    tracker.beginInput();
    if (event.pointerType !== "touch" || event.isPrimary === false) return;
    const row = rowFrom(event.target);
    const conversation = conversationFor(row);
    if (!row || !conversation) return;
    cancelGesture();
    tracker.start(row, event.clientX, event.clientY, { row, conversation });
  };
  const onPointerMove = event => {
    tracker.move(event.clientX, event.clientY);
  };
  const onClick = event => {
    const row = rowFrom(event.target);
    if (!row) return;
    if (tracker.consumeClick(row)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Context-menu clicks are handled only by `contextmenu`; never turn a
    // secondary-button click into chat navigation.
    if (event.button != null && event.button !== 0) return;
    actions.onOpen(row.dataset.personaId);
  };
  const onContextMenu = event => {
    const row = rowFrom(event.target);
    const conversation = conversationFor(row);
    if (!row || !conversation) return;
    event.preventDefault();
    cancelGesture();
    openConversationMenu(row, conversation, { x: event.clientX, y: event.clientY }, actions);
  };
  const onKeyDown = event => {
    const row = rowFrom(event.target);
    const conversation = conversationFor(row);
    if (!row || !conversation) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      actions.onOpen(row.dataset.personaId);
      return;
    }
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    openConversationMenu(row, conversation, {
      x: rect.left + Math.min(rect.width / 2, 48),
      y: rect.top + Math.min(rect.height / 2, 32),
    }, actions);
  };
  const onScroll = () => {
    cancelGesture();
    closeConversationMenu();
  };

  list.addEventListener("selectstart", onSelectStart);
  list.addEventListener("dragstart", onDragStart);
  list.addEventListener("pointerdown", onPointerDown, { passive: true });
  list.addEventListener("pointermove", onPointerMove, { passive: true });
  list.addEventListener("pointerup", cancelGesture, { passive: true });
  list.addEventListener("pointercancel", cancelGesture, { passive: true });
  list.addEventListener("click", onClick);
  list.addEventListener("contextmenu", onContextMenu);
  list.addEventListener("keydown", onKeyDown);
  list.addEventListener("scroll", onScroll, { passive: true });

  return () => {
    cancelGesture();
    closeConversationMenu();
    list.removeEventListener("selectstart", onSelectStart);
    list.removeEventListener("dragstart", onDragStart);
    list.removeEventListener("pointerdown", onPointerDown);
    list.removeEventListener("pointermove", onPointerMove);
    list.removeEventListener("pointerup", cancelGesture);
    list.removeEventListener("pointercancel", cancelGesture);
    list.removeEventListener("click", onClick);
    list.removeEventListener("contextmenu", onContextMenu);
    list.removeEventListener("keydown", onKeyDown);
    list.removeEventListener("scroll", onScroll);
  };
}