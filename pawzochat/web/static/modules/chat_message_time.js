/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

export const MESSAGE_TIME_GAP_MS = 5 * 60 * 1000;

export function shouldShowMessageTime(timestamp, previousTimestamp = null) {
  const currentTime = new Date(timestamp).getTime();
  if (!Number.isFinite(currentTime)) return false;
  if (!previousTimestamp) return true;

  const previousTime = new Date(previousTimestamp).getTime();
  return !Number.isFinite(previousTime)
    || currentTime - previousTime > MESSAGE_TIME_GAP_MS;
}