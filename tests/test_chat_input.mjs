import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const chatSource = await readFile(join(
  __dirname,
  "../pawzochat/web/static/modules/chat.js",
), "utf8");
const appSource = await readFile(join(
  __dirname,
  "../pawzochat/web/static/app.js",
), "utf8");
const css = await readFile(join(
  __dirname,
  "../pawzochat/web/static/style.css",
), "utf8");

const inputBarMatch = chatSource.match(/<div class="chat-input-bar">([\s\S]*?)<\/div>/);
assert.ok(inputBarMatch, "聊天输入栏应存在");
const inputBar = inputBarMatch[1];

assert.doesNotMatch(chatSource, /(?:id|class)="send-btn"/, "不应渲染发送按钮");
assert.doesNotMatch(css, /\.send-btn\b/, "不应保留发送按钮专属样式");
assert.ok(
  inputBar.indexOf('id="chat-input"') < inputBar.indexOf('id="emoji-picker-btn"')
    && inputBar.indexOf('id="emoji-picker-btn"') < inputBar.indexOf('id="plus-menu-btn"'),
  "输入栏顺序应为输入框、表情、附件",
);
assert.match(inputBar, /id="emoji-picker-btn"[^>]+aria-label="打开表情面板"/);
assert.match(inputBar, /id="plus-menu-btn"[^>]+aria-label="打开附件面板"/);
assert.match(inputBar, /id="chat-input"[^>]+enterkeyhint="send"/);
assert.match(chatSource, /id="emoji-picker-panel"/);
assert.match(chatSource, /id="plus-menu-panel"/);
assert.match(
  chatSource,
  /id="camera-file-input"[^>]+accept="image\/\*"[^>]+capture="environment"[^>]+onchange="PawzoChat\.onPhotoSelected\(this\)"/,
  "拍照输入应请求手机后置摄像头",
);
assert.match(chatSource, /export function takePhoto\(\)[\s\S]*?\$\("camera-file-input"\)[\s\S]*?input\.click\(\);/);
assert.match(chatSource, /export function onPhotoSelected\(input\) \{\s*onImageSelected\(input\);\s*\}/);
assert.ok(
  chatSource.indexOf("PawzoChat.takePhoto()") < chatSource.indexOf("PawzoChat.pickImage()"),
  "附件面板应先显示拍照入口",
);
assert.match(appSource, /takePhoto, onPhotoSelected/, "拍照操作应暴露给页面");
assert.match(chatSource, /export function insertEmoji[\s\S]*?_closeEmojiPicker\(\);[\s\S]*?inp\.focus\(\);/);
assert.match(chatSource, /export async function sendChat\(\)/, "公共发送逻辑应保留");
assert.match(appSource, /onChatCompositionStart, onChatCompositionEnd/, "组合输入事件应暴露给页面");

const keyHandlerMatch = chatSource.match(
  /export function onChatKey\(e\) \{([\s\S]*?)\n\}\n\nexport function takePhoto/,
);
assert.ok(keyHandlerMatch, "应存在输入框键盘处理逻辑");
const runKey = new Function(
  "$", "_pendingImages", "_pendingFiles", "sendChat", "_chatInputComposing", "e",
  keyHandlerMatch[1],
);

function exercise({ value = "消息", key = "Enter", shiftKey = false, isComposing = false, keyCode = 13, composing = false } = {}) {
  let prevented = false;
  let sent = 0;
  runKey(
    () => ({ value }),
    [],
    [],
    () => { sent += 1; },
    composing,
    { key, shiftKey, isComposing, keyCode, preventDefault() { prevented = true; } },
  );
  return { prevented, sent };
}

assert.deepEqual(exercise(), { prevented: true, sent: 1 }, "Enter 应发送非空消息");
assert.deepEqual(
  exercise({ isComposing: true }),
  { prevented: false, sent: 0 },
  "输入法组合期间 Enter 不应发送",
);
assert.deepEqual(
  exercise({ keyCode: 229 }),
  { prevented: false, sent: 0 },
  "输入法 229 键值不应发送",
);
assert.deepEqual(
  exercise({ shiftKey: true }),
  { prevented: false, sent: 0 },
  "Shift+Enter 应保留默认换行",
);
assert.deepEqual(
  exercise({ value: "   " }),
  { prevented: true, sent: 0 },
  "空输入 Enter 不应发送",
);

assert.match(css, /\.chat-input\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;/s);
assert.match(css, /\.img-upload-btn\s*\{[^}]*flex-shrink:\s*0;[^}]*width:\s*36px;\s*height:\s*36px;/s);

console.log("chat input tests passed");