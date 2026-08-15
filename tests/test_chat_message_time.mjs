import assert from "node:assert/strict";

import {
  MESSAGE_TIME_GAP_MS,
  shouldShowMessageTime,
} from "../pawzochat/web/static/modules/chat_message_time.js";

const start = "2026-08-16T02:00:00+08:00";
const after = milliseconds => new Date(new Date(start).getTime() + milliseconds).toISOString();

assert.equal(shouldShowMessageTime(start), true, "首条消息应立即显示时间");
assert.equal(
  shouldShowMessageTime(after(MESSAGE_TIME_GAP_MS), start),
  false,
  "恰好间隔五分钟不应重复显示时间",
);
assert.equal(
  shouldShowMessageTime(after(MESSAGE_TIME_GAP_MS + 1), start),
  true,
  "超过五分钟的新消息应立即显示时间",
);
assert.equal(
  shouldShowMessageTime("invalid", start),
  false,
  "无效时间不应生成错误的分隔条",
);

console.log("chat message time tests passed");