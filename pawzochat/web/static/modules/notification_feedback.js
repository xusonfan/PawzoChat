/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

const _handledMessageKeys = new Set();
let _audioContext = null;
let _notificationAudio = null;
let _gestureListenersRegistered = false;

const _NOTIFICATION_SOUND_URL = "/static/assets/notification.wav";
const _GESTURE_EVENTS = ["pointerdown", "touchend", "keydown"];

function _getNotificationAudio(factory) {
  if (_notificationAudio) return _notificationAudio;
  try {
    if (factory) {
      _notificationAudio = factory(_NOTIFICATION_SOUND_URL);
    } else if (typeof Audio !== "undefined") {
      _notificationAudio = new Audio(_NOTIFICATION_SOUND_URL);
    } else if (typeof window !== "undefined" && typeof window.Audio === "function") {
      _notificationAudio = new window.Audio(_NOTIFICATION_SOUND_URL);
    }
    if (_notificationAudio) _notificationAudio.preload = "auto";
  } catch (e) { /* unavailable media element or blocked construction */ }
  return _notificationAudio;
}

function _playNotificationFile(factory) {
  const audio = _getNotificationAudio(factory);
  if (!audio || typeof audio.play !== "function") {
    return Promise.reject(new Error("HTML audio is unavailable"));
  }
  try {
    audio.currentTime = 0;
    // Keep play() in this synchronous frame: preview callers invoke this directly
    // from the trusted click handler on mobile browsers.
    return Promise.resolve(audio.play()).then(() => true);
  } catch (error) {
    return Promise.reject(error);
  }
}

function _audioContextConstructor() {
  if (typeof window === "undefined") return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

function _getAudioContext(factory) {
  if (_audioContext?.state === "closed") _audioContext = null;
  if (_audioContext) return _audioContext;
  try {
    const AudioContextClass = factory || _audioContextConstructor();
    if (AudioContextClass) _audioContext = new AudioContextClass();
  } catch (e) { /* browser policy or missing audio device */ }
  return _audioContext;
}

function _removeGestureListeners() {
  if (!_gestureListenersRegistered || typeof document === "undefined") return;
  for (const eventName of _GESTURE_EVENTS) {
    document.removeEventListener(eventName, _unlockAudioFromGesture);
  }
  _gestureListenersRegistered = false;
}

function _primeAudioContext(context) {
  try {
    const buffer = context.createBuffer(1, 1, context.sampleRate || 44100);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0);
  } catch (e) { /* older WebViews may not support buffer priming */ }
}

function _unlockAudioFromGesture() {
  const context = _getAudioContext();
  if (!context) return;

  // These calls intentionally happen synchronously in the trusted event handler.
  // Awaiting before resume/start would lose the mobile browser user activation.
  let resumeResult;
  try {
    if (context.state === "suspended" || context.state === "interrupted") {
      resumeResult = context.resume();
    }
    _primeAudioContext(context);
    _removeGestureListeners();
  } catch (e) { /* a later message or preview can retry */ }
  Promise.resolve(resumeResult).catch(() => {});
}

function _registerGestureListeners() {
  if (_gestureListenersRegistered || typeof document === "undefined") return;
  for (const eventName of _GESTURE_EVENTS) {
    document.addEventListener(eventName, _unlockAudioFromGesture, { passive: true });
  }
  _gestureListenersRegistered = true;
}

_registerGestureListeners();

async function _ensureRunningContext(factory, prime = false) {
  const context = _getAudioContext(factory);
  if (!context) return null;
  try {
    if (context.state === "suspended" || context.state === "interrupted") {
      await context.resume();
    }
    if (prime) _primeAudioContext(context);
    return context.state === "running" ? context : null;
  } catch (e) {
    return null;
  }
}

function _scheduleTone(context, frequency, start, duration, peakGain = 0.045) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.01);
}

async function _playSound(factory, prime = false) {
  try {
    const context = await _ensureRunningContext(factory, prime);
    if (!context) return false;
    const now = context.currentTime;
    // Two short separated tones remain recognizable on small phone speakers
    // without increasing the existing gentle peak volume.
    _scheduleTone(context, 660, now, 0.12);
    _scheduleTone(context, 820, now + 0.13, 0.16, 0.04);
    return true;
  } catch (e) {
    return false; // feedback must never interrupt message handling
  }
}

export function previewNotificationSound(options = {}) {
  // _playNotificationFile invokes HTMLMediaElement.play() synchronously before
  // any promise/await boundary, preserving the click's mobile user activation.
  const filePlayback = _playNotificationFile(options.audioFactory);
  return filePlayback.catch(() => _playSound(options.audioContextFactory, true));
}

function _vibrate(navigatorObject) {
  try {
    const target = navigatorObject ?? (typeof navigator !== "undefined" ? navigator : null);
    if (typeof target?.vibrate === "function") target.vibrate(80);
  } catch (e) { /* unsupported or platform-blocked */ }
}

export function notificationMessageKey(event) {
  const personaId = event?.persona_id;
  const message = event?.message;
  if (event?.type !== "assistant_message" || !personaId || message?.role !== "assistant") return null;
  if (message._seq === undefined || message._seq === null) return null;
  return `${personaId}:${message._seq}`;
}

export function systemNotificationPermission() {
  if (
    typeof Notification === "undefined" ||
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !window.isSecureContext ||
    !("serviceWorker" in navigator)
  ) {
    return "unsupported";
  }
  return Notification.permission;
}

export async function requestSystemNotificationPermission() {
  const state = systemNotificationPermission();
  if (state === "unsupported" || state === "granted") return state;
  if (state === "denied") return state;
  try {
    return await Notification.requestPermission();
  } catch (e) {
    return "unsupported";
  }
}

const _NOTIFICATION_ICON_CACHE = "pawzo-notification-icons-v1";
const _notificationIcons = new Map();

function _personaAvatarUrl(persona) {
  if (!persona?.has_avatar) return "";
  const base = (typeof window !== "undefined" ? window.PAWZOCHAT_BASE : "") || "";
  const path = `${base}/api/personas/${encodeURIComponent(persona.id)}/avatar`;
  const versioned = persona.avatar_version
    ? `${path}?v=${encodeURIComponent(persona.avatar_version)}`
    : path;
  const origin = typeof window !== "undefined" ? window.location?.origin : "";
  return origin ? new URL(versioned, origin).href : versioned;
}

function _blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error || new Error("avatar decode failed"));
    reader.readAsDataURL(blob);
  });
}

export function cachedNotificationIcon(personaId) {
  return _notificationIcons.get(personaId) || "";
}

export async function prepareNotificationIcons(personas, options = {}) {
  const cacheStorage = options.cacheStorage ?? (typeof caches !== "undefined" ? caches : null);
  const fetchFn = options.fetchFn ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  const toDataUrl = options.toDataUrl ?? _blobToDataUrl;
  if (!cacheStorage || !fetchFn) return;

  const desired = new Map(
    (personas || [])
      .map(persona => [persona.id, _personaAvatarUrl(persona)])
      .filter(([, url]) => url),
  );
  for (const personaId of [..._notificationIcons.keys()]) {
    if (!desired.has(personaId)) _notificationIcons.delete(personaId);
  }

  try {
    const cache = await cacheStorage.open(_NOTIFICATION_ICON_CACHE);
    const desiredUrls = new Set(desired.values());
    const keys = await cache.keys();
    await Promise.all(keys.map(request => (
      desiredUrls.has(request.url) ? Promise.resolve() : cache.delete(request)
    )));

    await Promise.all([...desired].map(async ([personaId, url]) => {
      try {
        let response = await cache.match(url);
        if (!response) {
          response = await fetchFn(url, { credentials: "same-origin" });
          if (!response.ok) return;
          await cache.put(url, response.clone());
        }
        const dataUrl = await toDataUrl(await response.blob());
        if (dataUrl) _notificationIcons.set(personaId, dataUrl);
      } catch (e) {
        _notificationIcons.delete(personaId);
      }
    }));
  } catch (e) {
    // Notification delivery must never wait for or depend on avatar caching.
  }
}

function _notificationBody(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const text = blocks
    .filter(block => block?.type === "text" && block.text)
    .map(block => block.text.trim())
    .filter(Boolean)
    .join("\n");
  if (text) return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  if (blocks.some(block => block?.type === "image")) return "[图片]";
  if (blocks.some(block => block?.type === "voice" || block?.type === "audio")) return "[语音]";
  if (blocks.some(block => block?.type === "emoji")) return "[表情]";
  return "收到一条新消息";
}

export async function showSystemNotification(event, options = {}) {
  const NotificationApi = options.notificationApi ?? (typeof Notification !== "undefined" ? Notification : null);
  const navigatorObject = options.navigatorObject ?? (typeof navigator !== "undefined" ? navigator : null);
  if (NotificationApi?.permission !== "granted" || !navigatorObject?.serviceWorker) return false;

  try {
    const registration = options.registration ?? await navigatorObject.serviceWorker.ready;
    const base = (options.baseUrl ?? (typeof window !== "undefined" ? window.PAWZOCHAT_BASE : "") ?? "").replace(/\/$/, "");
    const payload = {
      body: _notificationBody(event?.message),
      icon: options.iconUrl || `${base}/static/logo.png`,
      badge: `${base}/static/pwa-icon-192.png`,
      tag: notificationMessageKey(event) || undefined,
      renotify: false,
      data: { personaId: event?.persona_id || "" },
    };
    try {
      await registration.showNotification(options.personaName || "PawzoChat", payload);
    } catch (error) {
      if (!options.iconUrl) throw error;
      await registration.showNotification(options.personaName || "PawzoChat", {
        ...payload,
        icon: `${base}/static/logo.png`,
      });
    }
    return true;
  } catch (e) {
    console.warn("系统通知展示失败", e);
    return false;
  }
}

export function notifyNewMessage(event, options = {}) {
  const key = notificationMessageKey(event);
  if (!key || _handledMessageKeys.has(key)) return false;
  _handledMessageKeys.add(key);

  const isViewing = options.isViewing === true;
  const settings = options.settings || {};
  const soundEnabled = settings.new_message_sound !== false;
  const vibrationEnabled = settings.new_message_vibration !== false;
  const NotificationApi = options.notificationApi ?? (typeof Notification !== "undefined" ? Notification : null);
  const systemNotificationEnabled = (
    options.systemNotificationsEnabled === true
    && NotificationApi?.permission === "granted"
    && !isViewing
  );
  if (systemNotificationEnabled) void showSystemNotification(event, options);
  if (soundEnabled) {
    void _playNotificationFile(options.audioFactory)
      .catch(() => _playSound(options.audioContextFactory));
  }
  if (vibrationEnabled) _vibrate(options.navigatorObject);
  return soundEnabled || vibrationEnabled || systemNotificationEnabled;
}

export function resetNotificationFeedbackForTests() {
  _handledMessageKeys.clear();
  _notificationIcons.clear();
  _audioContext = null;
  _notificationAudio = null;
}