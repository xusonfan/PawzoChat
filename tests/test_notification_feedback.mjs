import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gestureCalls = { contexts: 0, resumes: 0, bufferStarts: 0 };
const gestureListeners = new Map();
class GestureContext {
  constructor() {
    gestureCalls.contexts += 1;
    this.state = "suspended";
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.destination = {};
  }
  resume() { gestureCalls.resumes += 1; this.state = "running"; return Promise.resolve(); }
  createBuffer() { return {}; }
  createBufferSource() { return { connect() {}, start() { gestureCalls.bufferStarts += 1; } }; }
}
globalThis.window = { AudioContext: GestureContext };
globalThis.document = {
  addEventListener(name, handler) { gestureListeners.set(name, handler); },
  removeEventListener(name, handler) {
    if (gestureListeners.get(name) === handler) gestureListeners.delete(name);
  },
};
const moduleUrl = pathToFileURL(join(
  __dirname,
  "../pawzochat/web/static/modules/notification_feedback.js",
)).href + `?t=${Date.now()}`;
const mod = await import(moduleUrl);

function event(seq, overrides = {}) {
  return {
    type: "assistant_message",
    persona_id: "cat",
    message: { role: "assistant", _seq: seq },
    ...overrides,
  };
}

function fakeAudio(initialState = "running", options = {}) {
  const calls = { starts: 0, resumes: 0, bufferStarts: 0, contexts: 0 };
  class Context {
    constructor() {
      calls.contexts += 1;
      this.state = initialState;
      this.currentTime = 1;
      this.sampleRate = 48000;
      this.destination = {};
    }
    async resume() {
      calls.resumes += 1;
      if (options.resumeError) throw new Error("resume blocked");
      this.state = "running";
    }
    createBuffer() { return {}; }
    createBufferSource() {
      return {
        buffer: null,
        connect() {},
        start() { calls.bufferStarts += 1; },
      };
    }
    createOscillator() {
      if (options.playError) throw new Error("audio device failed");
      return {
        type: "",
        frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        start() { calls.starts += 1; },
        stop() {},
      };
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
      };
    }
  }
  return { Context, calls };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function fakeHtmlAudio(options = {}) {
  const calls = { factories: 0, plays: 0, rewinds: 0 };
  let currentTime = options.initialTime ?? 5;
  let resolvePlay;
  const pending = new Promise(resolve => { resolvePlay = resolve; });
  const element = {
    preload: "",
    get currentTime() { return currentTime; },
    set currentTime(value) { currentTime = value; calls.rewinds += 1; },
    play() {
      calls.plays += 1;
      if (options.throwPlay) throw new Error("media play threw");
      if (options.rejectPlay) return Promise.reject(new Error("media play rejected"));
      if (options.deferPlay) return pending;
      return Promise.resolve();
    },
  };
  return {
    calls,
    element,
    resolvePlay,
    factory() { calls.factories += 1; return element; },
  };
}

// First trusted gesture synchronously creates, resumes and primes one shared context.
assert.deepEqual([...gestureListeners.keys()].sort(), ["keydown", "pointerdown", "touchend"]);
gestureListeners.get("pointerdown")();
assert.equal(gestureCalls.contexts, 1);
assert.equal(gestureCalls.resumes, 1);
assert.equal(gestureCalls.bufferStarts, 1);
assert.equal(gestureListeners.size, 0);

// Stable identifier and duplicate SSE delivery: one actual message, one feedback.
mod.resetNotificationFeedbackForTests();
const audio = fakeAudio();
const vibrations = [];
const options = {
  audioContextFactory: audio.Context,
  navigatorObject: { vibrate: pattern => vibrations.push(pattern) },
};
assert.equal(mod.notificationMessageKey(event(7)), "cat:7");
assert.equal(mod.notifyNewMessage(event(7), options), true);
assert.equal(mod.notifyNewMessage(event(7), options), false);
await settle();
assert.equal(audio.calls.starts, 2);
assert.deepEqual(vibrations, [80]);

// Independent switches.
mod.resetNotificationFeedbackForTests();
const soundOnly = fakeAudio();
const noVibration = [];
assert.equal(mod.notifyNewMessage(event(8), {
  settings: { new_message_sound: true, new_message_vibration: false },
  audioContextFactory: soundOnly.Context,
  navigatorObject: { vibrate: p => noVibration.push(p) },
}), true);
await settle();
assert.equal(soundOnly.calls.starts, 2);
assert.deepEqual(noVibration, []);

mod.resetNotificationFeedbackForTests();
const vibrationOnly = fakeAudio();
const vibrationCalls = [];
assert.equal(mod.notifyNewMessage(event(9), {
  settings: { new_message_sound: false, new_message_vibration: true },
  audioContextFactory: vibrationOnly.Context,
  navigatorObject: { vibrate: p => vibrationCalls.push(p) },
}), true);
assert.equal(vibrationOnly.calls.starts, 0);
assert.deepEqual(vibrationCalls, [80]);

// A background-suspended context resumes before a real notification tone.
mod.resetNotificationFeedbackForTests();
const suspended = fakeAudio("suspended");
mod.notifyNewMessage(event(10), {
  audioContextFactory: suspended.Context,
  navigatorObject: { vibrate() {} },
});
await settle();
assert.equal(suspended.calls.resumes, 1);
assert.equal(suspended.calls.starts, 2);
assert.equal(suspended.calls.contexts, 1);

// Preview reaches HTMLAudioElement.play synchronously in the caller's click stack.
mod.resetNotificationFeedbackForTests();
const deferredHtml = fakeHtmlAudio({ deferPlay: true });
const unusedWebAudio = fakeAudio("running");
const deferredPreview = mod.previewNotificationSound({
  audioFactory: deferredHtml.factory,
  audioContextFactory: unusedWebAudio.Context,
});
assert.equal(deferredHtml.calls.plays, 1);
assert.equal(deferredHtml.calls.rewinds, 1);
assert.equal(deferredHtml.element.currentTime, 0);
assert.equal(unusedWebAudio.calls.contexts, 0);
deferredHtml.resolvePlay();
assert.equal(await deferredPreview, true);
assert.equal(unusedWebAudio.calls.starts, 0);

// One HTMLAudioElement is reused and rewound for consecutive notifications.
await mod.previewNotificationSound({ audioFactory: deferredHtml.factory });
assert.equal(deferredHtml.calls.factories, 1);
assert.equal(deferredHtml.calls.plays, 2);
assert.equal(deferredHtml.calls.rewinds, 2);

// A rejected media-element play falls back to the existing Web Audio tones.
mod.resetNotificationFeedbackForTests();
const rejectedHtml = fakeHtmlAudio({ rejectPlay: true });
const previewFallback = fakeAudio("suspended");
assert.equal(await mod.previewNotificationSound({
  audioFactory: rejectedHtml.factory,
  audioContextFactory: previewFallback.Context,
}), true);
assert.equal(rejectedHtml.calls.plays, 1);
assert.equal(previewFallback.calls.resumes, 1);
assert.equal(previewFallback.calls.bufferStarts, 1);
assert.equal(previewFallback.calls.starts, 2);

// Both channels failing produces an explicit false result for the settings UI.
mod.resetNotificationFeedbackForTests();
const doublyRejectedHtml = fakeHtmlAudio({ rejectPlay: true });
const doublyBrokenWebAudio = fakeAudio("running", { playError: true });
assert.equal(await mod.previewNotificationSound({
  audioFactory: doublyRejectedHtml.factory,
  audioContextFactory: doublyBrokenWebAudio.Context,
}), false);

// Playback failure is contained and vibration still executes synchronously.
mod.resetNotificationFeedbackForTests();
const liveRejectedHtml = fakeHtmlAudio({ rejectPlay: true });
const brokenPlayback = fakeAudio("running", { playError: true });
const fallbackVibrations = [];
assert.equal(mod.notifyNewMessage(event(101), {
  audioFactory: liveRejectedHtml.factory,
  audioContextFactory: brokenPlayback.Context,
  navigatorObject: { vibrate: p => fallbackVibrations.push(p) },
}), true);
assert.deepEqual(fallbackVibrations, [80]);
await settle();
assert.deepEqual(fallbackVibrations, [80]);
assert.equal(liveRejectedHtml.calls.plays, 1);
assert.equal(brokenPlayback.calls.starts, 0);

// History, own messages and current visible conversation do not alert.
mod.resetNotificationFeedbackForTests();
assert.equal(mod.notifyNewMessage({ type: "history_loaded", persona_id: "cat", message: { role: "assistant", _seq: 10 } }, options), false);
assert.equal(mod.notifyNewMessage(event(11, { message: { role: "user", _seq: 11 } }), options), false);
assert.equal(mod.notifyNewMessage(event(12), { ...options, isViewing: true }), false);
assert.equal(audio.calls.starts, 2);
assert.deepEqual(vibrations, [80]);

// Missing platform capabilities and failed audio construction degrade silently.
mod.resetNotificationFeedbackForTests();
assert.doesNotThrow(() => mod.notifyNewMessage(event(13), {
  audioContextFactory: class { constructor() { throw new Error("blocked"); } },
  navigatorObject: {},
}));
assert.equal(mod.notifyNewMessage(event(13), options), false);

// Settings UI persists both booleans through the existing /api/settings chat patch.
const settingsSource = await readFile(join(
  __dirname,
  "../pawzochat/web/static/modules/settings.js",
), "utf8");
assert.match(settingsSource, /id="sc-sound"[^>]*role="switch"/);
assert.match(settingsSource, /aria-label="试听新消息提示音"/);
assert.match(settingsSource, /export function previewNewMessageSound\(\)[\s\S]*const playback = previewNotificationSound\(\)/);
assert.match(settingsSource, /if \(!played\) toast\("提示音播放失败，请检查浏览器媒体权限或静音设置", "error"\)/);
assert.match(settingsSource, /试听不受开关影响/);
assert.match(settingsSource, /id="sc-vibration"[^>]*role="switch"/);
// Chat notification action groups align controls, while their switches retain the
// project's fixed geometry instead of inheriting the generic form label max-width.
assert.match(settingsSource, /#settings-chat-page \.notification-setting-actions \{[\s\S]*?display: flex;[\s\S]*?align-items: center;[\s\S]*?justify-content: flex-end;[\s\S]*?margin-left: auto;[\s\S]*?\}/);
assert.match(settingsSource, /#settings-chat-page \.notification-setting-actions \.switch-wrap \{[\s\S]*?position: relative;[\s\S]*?width: 44px;[\s\S]*?min-width: 44px;[\s\S]*?max-width: 44px;[\s\S]*?height: 26px;[\s\S]*?flex: 0 0 44px;[\s\S]*?\}/);
assert.match(settingsSource, /@media \(max-width: 420px\) \{\s*#settings-chat-page \.notification-setting-actions \{ gap: 6px; \}\s*\}/);
assert.doesNotMatch(settingsSource, /@media \(max-width: 420px\) \{[\s\S]*?#settings-chat-page \.notification-setting-row/);
assert.doesNotMatch(settingsSource, /@media \(max-width: 420px\) \{[\s\S]*?#settings-chat-page \.notification-sound-preview/);
assert.match(settingsSource, /new_message_sound:\s*\$\("sc-sound"\)\.checked/);
assert.match(settingsSource, /new_message_vibration:\s*\$\("sc-vibration"\)\.checked/);
assert.match(settingsSource, /api\.patch\("\/api\/settings",\s*\{ chat: patch \}\)/);

const configSource = await readFile(join(__dirname, "../pawzochat/core/config.py"), "utf8");
assert.match(configSource, /"new_message_sound": True/);
assert.match(configSource, /"new_message_vibration": True/);

const wav = await readFile(join(
  __dirname,
  "../pawzochat/web/static/assets/notification.wav",
));
assert.ok(wav.length > 44, "notification WAV must contain audio frames");
assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");

console.log("notification feedback tests passed");