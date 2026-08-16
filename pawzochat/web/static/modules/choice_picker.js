/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { closeOverlay, showSheet } from "./ui.js";
import { esc, jsArg } from "./utils.js";

let selectionHandler = null;

function normalizedOptions(options) {
  return (options || [])
    .filter(option => option && option.value != null)
    .map(option => ({
      value: String(option.value),
      label: String(option.label ?? option.value),
      description: String(option.description || ""),
      disabled: option.disabled === true,
    }));
}

export function buildChoicePickerHtml({ title, options, selectedValue }) {
  const selected = String(selectedValue ?? "");
  const rows = normalizedOptions(options).map(option => {
    const active = option.value === selected;
    const classes = [
      "choice-picker-option",
      active ? "is-selected" : "",
      option.disabled ? "is-disabled" : "",
    ].filter(Boolean).join(" ");
    const description = option.description
      ? `<small>${esc(option.description)}</small>`
      : "";
    return `<button type="button" class="${classes}" role="radio" aria-checked="${active}" ${option.disabled ? "disabled" : ""} onclick="PawzoChat.choicePickerSelect(${jsArg(option.value)})">
      <span class="choice-picker-option-copy">
        <strong>${esc(option.label)}</strong>
        ${description}
      </span>
      <span class="choice-picker-check" aria-hidden="true">✓</span>
    </button>`;
  }).join("");

  return `<div class="choice-picker">
    <div class="sheet-title">${esc(title || "请选择")}</div>
    <div class="choice-picker-list" role="radiogroup">
      ${rows || '<div class="choice-picker-empty">暂无可选项</div>'}
    </div>
    <button type="button" class="sheet-cancel choice-picker-cancel" onclick="PawzoChat.closeOverlay()">取消</button>
  </div>`;
}

export function openChoicePicker(config) {
  selectionHandler = typeof config.onSelect === "function"
    ? config.onSelect
    : null;
  showSheet(
    buildChoicePickerHtml(config),
    () => { selectionHandler = null; },
  );
}

export function choicePickerSelect(value) {
  const handler = selectionHandler;
  closeOverlay();
  if (handler) handler(String(value));
}