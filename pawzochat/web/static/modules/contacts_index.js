/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

export const CONTACT_INDEX_LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"];

let _activePointerId = null;
let _bubbleTimer = null;

function _initial(persona) {
  const initial = String(persona?.initial || "").toUpperCase();
  return CONTACT_INDEX_LETTERS.includes(initial) ? initial : "#";
}

export function groupPersonasByInitial(personas) {
  const sorted = [...(personas || [])].sort((left, right) => {
    const leftKey = String(left?.sort_key || left?.name || "");
    const rightKey = String(right?.sort_key || right?.name || "");
    return leftKey.localeCompare(rightKey, "zh-CN");
  });
  const groups = new Map();
  for (const persona of sorted) {
    const initial = _initial(persona);
    if (!groups.has(initial)) groups.set(initial, []);
    groups.get(initial).push(persona);
  }
  return CONTACT_INDEX_LETTERS
    .filter(initial => groups.has(initial))
    .map(initial => ({ initial, personas: groups.get(initial) }));
}

function _setActiveInitial(initial) {
  document.querySelectorAll(".contacts-index-letter").forEach(button => {
    button.classList.toggle("is-active", button.dataset.initial === initial);
  });
  const bubble = document.getElementById("contacts-index-bubble");
  if (!bubble) return;
  bubble.textContent = initial;
  bubble.classList.add("is-visible");
  clearTimeout(_bubbleTimer);
  _bubbleTimer = setTimeout(() => bubble.classList.remove("is-visible"), 450);
}

export function jumpToContactInitial(initial) {
  const section = document.getElementById(`contacts-section-${initial === "#" ? "other" : initial}`);
  if (!section || section.hidden) return;
  section.scrollIntoView({ block: "start", behavior: "auto" });
  _setActiveInitial(initial);
}

function _initialAtPointer(nav, clientY) {
  const buttons = [...nav.querySelectorAll(".contacts-index-letter")];
  if (!buttons.length) return "";
  const rect = nav.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(0.999999, (clientY - rect.top) / rect.height));
  const startIndex = Math.floor(ratio * buttons.length);
  for (let distance = 0; distance < buttons.length; distance += 1) {
    for (const index of [startIndex - distance, startIndex + distance]) {
      const button = buttons[index];
      if (button && !button.disabled) return button.dataset.initial || "";
    }
  }
  return "";
}

function _jumpFromPointer(event) {
  const nav = event.currentTarget;
  const initial = _initialAtPointer(nav, event.clientY);
  if (initial) jumpToContactInitial(initial);
}

export function contactsIndexStart(event) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  event.preventDefault();
  _activePointerId = event.pointerId;
  event.currentTarget.setPointerCapture?.(event.pointerId);
  _jumpFromPointer(event);
}

export function contactsIndexMove(event) {
  if (_activePointerId !== event.pointerId) return;
  event.preventDefault();
  _jumpFromPointer(event);
}

export function contactsIndexEnd(event) {
  if (_activePointerId !== event.pointerId) return;
  _activePointerId = null;
  event.currentTarget.releasePointerCapture?.(event.pointerId);
}

export function syncContactIndexAvailability() {
  document.querySelectorAll(".contacts-section").forEach(section => {
    const hasVisibleRows = [...section.querySelectorAll(".persona-row")]
      .some(row => row.style.display !== "none");
    section.hidden = !hasVisibleRows;
  });
  document.querySelectorAll(".contacts-index-letter").forEach(button => {
    const initial = button.dataset.initial || "";
    const section = document.getElementById(`contacts-section-${initial === "#" ? "other" : initial}`);
    button.disabled = !section || section.hidden;
  });
}