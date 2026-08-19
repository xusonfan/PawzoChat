/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

function imageFailureNotice(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const failed = blocks.find(block => (
    block?.type === "image"
    && block.status === "failed"
    && typeof block.error === "string"
    && block.error.trim()
  ));
  return failed
    ? { title: "图片生成失败", message: failed.error.trim() }
    : null;
}

export function errorNoticeFromEvent(event) {
  if (event?.type === "operation_error" && typeof event.message === "string") {
    const message = event.message.trim();
    if (!message) return null;
    const title = typeof event.title === "string" && event.title.trim()
      ? event.title.trim()
      : "请求异常";
    return { title, message };
  }
  if (event?.type === "assistant_message_updated") {
    return imageFailureNotice(event.message);
  }
  return null;
}