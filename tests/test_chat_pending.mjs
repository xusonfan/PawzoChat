import assert from "node:assert/strict";

import {
  addPendingUserMessage,
  clearPendingUserMessages,
  confirmPendingUserMessage,
  mergePendingUserMessages,
  projectPendingConversationSummaries,
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

clearPendingUserMessages(personaId);
const listPendingMessage = {
  role: "user",
  content: [{ type: "text", text: "刚发出的消息" }],
  source: "web",
  timestamp: "2026-08-16T02:01:00+08:00",
};
addPendingUserMessage(personaId, listPendingMessage);
const serverConversations = [{
  persona_id: personaId,
  pinned: false,
  unread_count: 4,
  updated_at: "2026-08-16T02:00:00+08:00",
  last_message: {
    role: "assistant",
    text: "上一条回复",
    timestamp: "2026-08-16T02:00:00+08:00",
  },
}, {
  persona_id: "older",
  pinned: false,
  unread_count: 0,
  updated_at: "2026-08-16T01:00:00+08:00",
  last_message: null,
}];
const projected = projectPendingConversationSummaries(serverConversations);
assert.equal(projected[0].persona_id, personaId, "待发送消息应更新会话排序");
assert.equal(projected[0].last_message.role, "user");
assert.equal(projected[0].last_message.text, "刚发出的消息");
assert.equal(projected[0].last_message.timestamp, listPendingMessage.timestamp);
assert.equal(projected[0].unread_count, 4, "摘要投影不得修改未读数");

const persistedProjection = projectPendingConversationSummaries([{
  ...serverConversations[0],
  updated_at: listPendingMessage.timestamp,
  last_message: {
    role: "user",
    text: "刚发出的消息",
    timestamp: listPendingMessage.timestamp,
  },
}]);
assert.equal(persistedProjection[0].last_message.text, "刚发出的消息");
assert.deepEqual(
  mergePendingUserMessages(personaId, []),
  [],
  "服务端摘要追上后应清除列表中的待确认投影",
);

console.log("chat pending message tests passed");