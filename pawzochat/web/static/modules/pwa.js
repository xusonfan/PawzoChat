/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { showSheet, toast } from "./ui.js";

let deferredInstallPrompt = null;
let installBanner = null;

const baseUrl = () => (window.PAWZOCHAT_BASE || "").replace(/\/$/, "");

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  window.navigator.standalone === true;

const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;

function removeInstallBanner() {
  installBanner?.remove();
  installBanner = null;
}

function dismissInstallBanner() {
  sessionStorage.setItem("pawzo_pwa_prompt_dismissed", "1");
  removeInstallBanner();
}

function showInstallBanner() {
  if (isStandalone() || installBanner || sessionStorage.getItem("pawzo_pwa_prompt_dismissed")) return;
  if (!deferredInstallPrompt && !isIos()) return;

  installBanner = document.createElement("div");
  installBanner.className = "pwa-install-banner";
  installBanner.setAttribute("role", "dialog");
  installBanner.setAttribute("aria-label", "安装 PawzoChat");
  installBanner.innerHTML = `
    <img src="${baseUrl()}/static/pwa-icon-192.png?v=2" alt="">
    <div class="pwa-install-copy">
      <strong>安装 PawzoChat</strong>
      <span>添加到桌面，以独立窗口全屏使用</span>
    </div>
    <button type="button" class="pwa-install-action">安装</button>
    <button type="button" class="pwa-install-close" aria-label="暂不安装">×</button>`;
  installBanner.querySelector(".pwa-install-action")?.addEventListener("click", requestPwaInstall);
  installBanner.querySelector(".pwa-install-close")?.addEventListener("click", dismissInstallBanner);
  document.body.appendChild(installBanner);
}

function showIosInstructions() {
  showSheet(`
    <div style="padding:12px 20px 24px">
      <div class="sheet-title">安装 PawzoChat</div>
      <div style="color:var(--text-2);font-size:14px;line-height:1.8">
        在 Safari 底部点击“分享”，然后选择“添加到主屏幕”。安装后将以独立窗口运行。
      </div>
    </div>`);
}

export async function requestPwaInstall() {
  if (isStandalone()) return;
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    removeInstallBanner();
    return;
  }
  if (isIos()) {
    showIosInstructions();
    return;
  }
  toast("请在浏览器菜单中选择“安装应用”或“添加到主屏幕”");
}

export function pwaInstallState() {
  if (isStandalone()) return "installed";
  if (deferredInstallPrompt || isIos()) return "available";
  return "browser";
}

export async function initPwa() {
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    showInstallBanner();
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    removeInstallBanner();
  });

  if ("serviceWorker" in navigator && window.isSecureContext) {
    try {
      await navigator.serviceWorker.register(`${baseUrl()}/sw.js`, { scope: `${baseUrl()}/` });
    } catch (error) {
      console.warn("PWA Service Worker 注册失败", error);
    }
  }

  if (isIos()) showInstallBanner();
}