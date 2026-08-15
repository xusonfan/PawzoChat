import assert from "node:assert/strict";

import {
  addPendingUserMessage,
  clearPendingUserMessages,
  confirmPendingUserMessage,
  mergePendingUserMessages,
  removePendingUserMessage,
} from "../pawzochat/web/static/modules/chat_pending.js";

const personaId = "pending-test";
const serverMessage = {
  role: "assistant",
  content: [{ type: "text", text: "上一轮回复" }],
  source: "llm",
  timestamp: "2026-08-16T02:00:00+08:00",
};
const optimisticMessage = {
  role: "user",
  content: [{ type: "text", text: "回复过程中发送" }],
  source: "web",
  timestamp: "2026-08-16T02:00:01+08:00",
};

clearPendingUserMessages(personaId);
const pendingId = addPendingUserMessage(personaId, optimisticMessage);
assert.deepEqual(
  mergePendingUserMessages(personaId, [serverMessage]),
  [serverMessage, optimisticMessage],
  "服务端旧快照不得覆盖本地待确认消息",
);

const acceptedMessage = { ...optimisticMessage, timestamp: "2026-08-16T02:00:02+08:00" };
confirmPendingUserMessage(personaId, pendingId, acceptedMessage);
assert.deepEqual(
  mergePendingUserMessages(personaId, [serverMessage]),
  [serverMessage, acceptedMessage],
  "接口确认后应使用服务端规范化消息参与合并",
);
assert.deepEqual(
  mergePendingUserMessages(personaId, [serverMessage, acceptedMessage]),
  [serverMessage, acceptedMessage],
  "服务端包含该消息后应清除待确认副本且不重复渲染",
);

const removableId = addPendingUserMessage(personaId, optimisticMessage);
removePendingUserMessage(personaId, removableId);
assert.deepEqual(
  mergePendingUserMessages(personaId, [serverMessage]),
  [serverMessage],
  "发送失败的消息不应继续保留在待确认集合中",
);

console.log("chat pending message tests passed");