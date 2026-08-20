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
const apiSource = await readFile(join(
  __dirname,
  "../pawzochat/web/static/modules/api.js",
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
  inputBar.indexOf('id="voice-mode-btn"') < inputBar.indexOf('id="chat-input"')
    && inputBar.indexOf('id="chat-input"') < inputBar.indexOf('id="emoji-picker-btn"')
    && inputBar.indexOf('id="emoji-picker-btn"') < inputBar.indexOf('id="plus-menu-btn"'),
  "输入栏顺序应为语音切换、输入框、表情、附件",
);
assert.match(inputBar, /id="voice-hold-btn"[\s\S]+onpointerdown="PawzoChat\.startVoiceRecording\(event\)"/);
assert.match(inputBar, /id="emoji-picker-btn"[^>]+aria-label="打开表情面板"/);
assert.match(inputBar, /id="plus-menu-btn"[^>]+aria-label="打开附件面板"/);
assert.match(inputBar, /id="chat-input"[^>]+enterkeyhint="send"/);
assert.match(chatSource, /id="emoji-picker-panel"/);
assert.match(chatSource, /id="plus-menu-panel"/);
const emojiMessageMarkup = chatSource.match(/return `<div class="msg-emoji">[\s\S]*?<\/div>`;/);
assert.ok(emojiMessageMarkup, "聊天消息应保留独立的表情渲染结构");
assert.doesNotMatch(
  emojiMessageMarkup[0],
  /openImagePreview|onclick=/,
  "表情消息不应绑定图片查看或放大行为",
);
assert.match(emojiMessageMarkup[0], /draggable="false"/, "表情图片不应允许拖拽");
assert.match(css, /\.msg-emoji\s*\{[^}]*user-select:\s*none;[^}]*-webkit-tap-highlight-color:\s*transparent;/s);
assert.match(css, /\.msg-emoji img\s*\{[^}]*pointer-events:\s*none;[^}]*-webkit-user-drag:\s*none;/s);
assert.match(
  chatSource,
  /class="msg-image linked-image"[\s\S]*?onclick="PawzoChat\.openImagePreview\(this\.src\)"/,
  "普通图片仍应支持点击预览",
);
assert.match(
  chatSource,
  /id="chat-new-message-btn" hidden onclick="PawzoChat\.scrollToLatestMessage\(\)"/,
  "聊天页应提供输入框上方的新消息按钮",
);
assert.match(
  chatSource,
  /if \(wasAtBottom\)[\s\S]*?_scrollAfterInsert\(msgsEl\);[\s\S]*?else[\s\S]*?_setNewMessageButtonVisible\(true\);/,
  "离开底部收到实时消息时应显示按钮",
);
assert.match(
  chatSource,
  /export function scrollToLatestMessage\(\)[\s\S]*?scrollToBottom\(messagesEl\)[\s\S]*?_setNewMessageButtonVisible\(false\)/,
  "点击按钮应滚到底部并隐藏按钮",
);
assert.match(appSource, /scrollToLatestMessage/, "回到底部操作应暴露给页面");
assert.match(css, /\.chat-new-message-anchor\s*\{[^}]*height:\s*0;/s);
assert.match(css, /\.chat-new-message-btn\s*\{[^}]*position:\s*absolute;[^}]*right:\s*12px;[^}]*bottom:\s*10px;/s);
assert.doesNotMatch(chatSource, /id="camera-file-input"/, "拍照不应再依赖可能打开相册的文件输入");
assert.match(
  chatSource,
  /navigator\.mediaDevices\.getUserMedia\(\{[\s\S]*?facingMode: \{ ideal: "environment" \}[\s\S]*?audio: false/,
  "拍照应通过浏览器摄像头 API 请求后置镜头",
);
assert.match(chatSource, /export function capturePhoto\(\)[\s\S]*?drawImage\(video[\s\S]*?canvas\.toBlob/);
assert.match(chatSource, /_cameraStream\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
assert.ok(
  chatSource.indexOf("PawzoChat.takePhoto()") < chatSource.indexOf("PawzoChat.pickImage()"),
  "附件面板应先显示拍照入口",
);
assert.match(appSource, /takePhoto, capturePhoto/, "摄像头操作应暴露给页面");
assert.match(appSource, /toggleVoiceInputMode, startVoiceRecording, moveVoiceRecording, finishVoiceRecording, cancelVoiceRecording/, "语音输入操作应暴露给页面");
assert.match(chatSource, /fetch\(`\$\{base\}\/api\/asr\/transcriptions`/);
assert.match(chatSource, /await sendChat\(\)/, "识别文字应复用现有消息发送链路");
assert.match(chatSource, /export function insertEmoji[\s\S]*?_closeEmojiPicker\(\);[\s\S]*?inp\.focus\(\);/);
assert.match(chatSource, /export async function sendChat\(\)/, "公共发送逻辑应保留");
assert.match(
  chatSource,
  /const res = await api\.get\(messagesUrl, \{ bypassCache: true \}\)/,
  "聊天窗口展示缓存后必须再请求一次权威消息快照",
);
assert.doesNotMatch(
  chatSource,
  /api\.get\(messagesUrl, \{[\s\S]*?onUpdate:/,
  "已读写入可能使后台重验证失效，聊天窗口不能依赖 onUpdate 获取最新消息",
);
assert.match(
  chatSource,
  /api\.post\([\s\S]*?\/messages`[\s\S]*?\{ keepalive: true \}/,
  "纯文本消息应允许切后台后继续提交",
);
assert.match(apiSource, /async post\(url, body, \{ keepalive = false \} = \{\}\)/);
assert.match(apiSource, /body: JSON\.stringify\(body\),\s*keepalive,/);
assert.match(appSource, /onChatCompositionStart, onChatCompositionEnd/, "组合输入事件应暴露给页面");
assert.match(
  chatSource,
  /const latestUserAttr = role === "user" && sequence === latestUserSequence[\s\S]*?data-latest-user="true"/,
  "只有最后一条已保存的用户消息应标记为可重新生成",
);
assert.match(
  chatSource,
  /row\.dataset\.latestUser === "true"[\s\S]*?PawzoChat\.regenerateChatReply\(\)/,
  "长按菜单应只为最后用户消息增加重新生成按钮",
);
assert.match(
  chatSource,
  /\/messages\/\$\{messageSeq\}\/regenerate/,
  "重新生成操作应调用独立接口",
);
assert.match(appSource, /regenerateChatReply/, "重新生成操作应暴露给页面");

const keyHandlerMatch = chatSource.match(
  /export function onChatKey\(e\) \{([\s\S]*?)\n\}\n\nfunction _setVoiceButtonState/,
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