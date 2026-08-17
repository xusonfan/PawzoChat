/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { api } from "./api.js";
import { systemNotificationPermission } from "./notification_feedback.js";

const _SYSTEM_NOTIFICATIONS_KEY = "pawzochat-system-notifications";
let _subscribed = false;
let _notificationPreference = null;

function _storedNotificationPreference() {
  try {
    const value = window.localStorage?.getItem(_SYSTEM_NOTIFICATIONS_KEY);
    if (value === "enabled") return true;
    if (value === "disabled") return false;
  } catch (_) {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  return _notificationPreference;
}

function _setNotificationPreference(enabled) {
  _notificationPreference = enabled;
  try {
    window.localStorage?.setItem(
      _SYSTEM_NOTIFICATIONS_KEY,
      enabled ? "enabled" : "disabled",
    );
  } catch (_) {
    // The in-memory preference still keeps this page internally consistent.
  }
}

function _pushSupported() {
  return (
    systemNotificationPermission() !== "unsupported"
    && typeof PushManager !== "undefined"
    && "serviceWorker" in navigator
  );
}

function _decodeApplicationServerKey(value) {
  const padded = `${value}${"=".repeat((4 - value.length % 4) % 4)}`;
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

function _sameApplicationServerKey(subscription, publicKey) {
  const current = subscription?.options?.applicationServerKey;
  if (!current) return true;
  const expected = _decodeApplicationServerKey(publicKey);
  const actual = new Uint8Array(current);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}

async function _publicKey() {
  const response = await api.get("/api/push/public-key", { bypassCache: true });
  if (!response?.public_key) throw new Error(response?.error || "服务器未提供推送公钥");
  return response.public_key;
}

async function _saveSubscription(subscription) {
  const response = await api.post("/api/push/subscriptions", {
    subscription: subscription.toJSON(),
  });
  if (response.status >= 400) {
    throw new Error(response.data?.error || "推送订阅保存失败");
  }
  _subscribed = true;
  _setNotificationPreference(true);
  return subscription;
}

async function _ensureSubscription({ create }) {
  if (!_pushSupported()) throw new Error("当前环境不支持后台推送");
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription && !create) {
    _subscribed = false;
    return null;
  }

  const publicKey = await _publicKey();
  if (subscription && !_sameApplicationServerKey(subscription, publicKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _decodeApplicationServerKey(publicKey),
    });
  }
  return _saveSubscription(subscription);
}

export function systemNotificationsEnabled() {
  return _storedNotificationPreference() === true && _subscribed;
}

export function webPushState() {
  if (!_pushSupported()) return "unsupported";
  const permission = systemNotificationPermission();
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "prompt";
  return systemNotificationsEnabled() ? "enabled" : "disabled";
}

export async function refreshWebPushState() {
  if (!_pushSupported() || systemNotificationPermission() !== "granted") {
    _subscribed = false;
    return webPushState();
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    _subscribed = !!await registration.pushManager.getSubscription();
    if (_storedNotificationPreference() === null) {
      _setNotificationPreference(_subscribed);
    }
  } catch (_) {
    _subscribed = false;
  }
  return webPushState();
}

export async function subscribeWebPush() {
  if (systemNotificationPermission() !== "granted") {
    throw new Error("尚未获得通知权限");
  }
  await _ensureSubscription({ create: true });
  return webPushState();
}

export async function unsubscribeWebPush() {
  if (!_pushSupported()) throw new Error("当前环境不支持后台推送");
  _setNotificationPreference(false);

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    _subscribed = false;
    return webPushState();
  }

  const endpoint = subscription.endpoint;
  const removed = await subscription.unsubscribe();
  if (removed) _subscribed = false;

  const response = await api.del("/api/push/subscriptions", { endpoint });
  if (response.status >= 400) {
    console.warn("服务端推送订阅删除失败", response.data?.error || response.status);
  }
  if (!removed && response.status >= 400) {
    throw new Error("浏览器与服务端均未能关闭推送订阅");
  }
  return webPushState();
}

export async function syncWebPushSubscription() {
  if (
    systemNotificationPermission() !== "granted"
    || _storedNotificationPreference() === false
  ) return webPushState();
  try {
    await _ensureSubscription({ create: false });
  } catch (error) {
    console.warn("Web Push 订阅同步失败", error);
    _subscribed = false;
  }
  return webPushState();
}

export function resetWebPushStateForTests() {
  _subscribed = false;
  _notificationPreference = null;
}
