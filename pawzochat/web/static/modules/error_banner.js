/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { $ } from "./state.js";

let generation = 0;

export function showErrorBanner(message, title = "请求异常") {
  const banner = $("error-banner");
  if (!banner) return;
  const currentGeneration = ++generation;
  const messageEl = banner.querySelector(".error-banner-message");
  const toggle = banner.querySelector(".error-banner-toggle");
  banner.querySelector(".error-banner-title").textContent = title;
  messageEl.textContent = String(message || "未知异常");
  banner.classList.remove("hide", "expanded");
  toggle.classList.add("hide");
  toggle.textContent = "展开详情";
  requestAnimationFrame(() => {
    if (currentGeneration !== generation || banner.classList.contains("hide")) return;
    toggle.classList.toggle("hide", messageEl.scrollHeight <= messageEl.clientHeight + 1);
    banner.classList.add("show");
  });
}

export function toggleErrorBanner() {
  const banner = $("error-banner");
  if (!banner || banner.classList.contains("hide")) return;
  const expanded = banner.classList.toggle("expanded");
  banner.querySelector(".error-banner-toggle").textContent = expanded ? "收起详情" : "展开详情";
}

export function closeErrorBanner() {
  const banner = $("error-banner");
  if (!banner) return;
  const currentGeneration = ++generation;
  banner.classList.remove("show", "expanded");
  setTimeout(() => {
    if (currentGeneration === generation) banner.classList.add("hide");
  }, 200);
}