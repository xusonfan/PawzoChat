/*!
 * PawzoChat - Human-like, versatile, extensible AI companion engine
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
// Shared inline verify-code (pair-code) widget for the WeChat QR login.
//
// Some scans trigger a server-side challenge (`need_verifycode`): the user
// must type the digits shown on their phone. This widget renders an inline
// input directly below the existing QR status line — only when the server
// asks for it — so the normal scan→confirm flow is visually unchanged. The
// typed code is handed back via `onSubmit` and the caller threads it into the
// next status poll. Used by both quick_setup.js and settings.js.

const BLOCK_CLASS = "qr-verify-block";

function _findBlock(statusEl) {
  const parent = statusEl && statusEl.parentNode;
  return parent ? parent.querySelector("." + BLOCK_CLASS) : null;
}

/**
 * Render an inline verify-code input right after `statusEl`. Idempotent: if
 * the block already exists it is left untouched (preserving any typed value).
 * `onSubmit(code)` receives the sanitized digit string.
 */
export function renderVerifyInput(statusEl, onSubmit) {
  if (!statusEl || _findBlock(statusEl)) return;

  const block = document.createElement("div");
  block.className = BLOCK_CLASS;
  block.style.cssText =
    "display:flex;gap:8px;justify-content:center;align-items:center;margin-top:12px";

  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.maxLength = 6;
  input.placeholder = "请输入验证码";
  input.style.cssText =
    "width:130px;border:1px solid var(--divider);border-radius:8px;" +
    "padding:8px 10px;font-size:15px;letter-spacing:3px;text-align:center;" +
    "outline:none;background:var(--bg);color:var(--text-1);font-family:var(--font)";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "确认";
  btn.style.cssText =
    "padding:8px 16px;border:none;border-radius:var(--radius-btn);" +
    "background:var(--primary);color:#fff;font-size:14px;cursor:pointer;" +
    "font-family:var(--font)";

  const submit = () => {
    const code = (input.value || "").replace(/\D/g, "");
    if (!code) { input.focus(); return; }
    try { onSubmit(code); } catch (_) { /* swallow */ }
    statusEl.textContent = "正在验证…";
  };

  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  });

  block.appendChild(input);
  block.appendChild(btn);
  statusEl.insertAdjacentElement("afterend", block);
  input.focus();
}

/** Remove the verify-code input block, if present. */
export function clearVerifyInput(statusEl) {
  const block = _findBlock(statusEl);
  if (block) block.remove();
}
