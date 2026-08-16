import assert from "node:assert/strict";

import {
  hasRenderedMessage,
  messageSequence,
} from "../pawzochat/web/static/modules/chat_message_identity.js";

const storedMessage = { _seq: 23, role: "assistant" };
assert.equal(messageSequence(storedMessage), "23");
assert.equal(messageSequence({ role: "assistant" }), "");
assert.equal(messageSequence({ _seq: "23" }), "");

const container = {
  querySelectorAll() {
    return [
      { dataset: { messageSeq: "22" } },
      { dataset: { messageSeq: "23" } },
    ];
  },
};
assert.equal(
  hasRenderedMessage(container, storedMessage),
  true,
  "同一服务端消息重复到达时不得再次插入",
);
assert.equal(
  hasRenderedMessage(container, { _seq: 24 }),
  false,
  "不同序号的消息必须正常插入",
);
assert.equal(
  hasRenderedMessage(container, { role: "assistant" }),
  false,
  "没有服务端序号时不应根据文本猜测去重",
);

console.log("chat message identity tests passed");