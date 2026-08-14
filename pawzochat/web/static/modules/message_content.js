/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
import { esc, escAttr } from "./utils.js";

const MARKDOWN_IMAGE_PATTERNS = [
  {
    pattern: /!\[([^\]\r\n]*)\]\(\s*(https?:\/\/[^\s)]+)(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?\s*\)/giu,
    requireImageFile: false,
  },
  {
    pattern: /\[((?:图片|图像|照片|image|img|picture)(?:链接|地址|url)?)\]\(\s*(https?:\/\/[^\s)]+)(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?\s*\)/giu,
    requireImageFile: false,
  },
  {
    pattern: /\[([^\]\r\n]+)\]\(\s*(https?:\/\/[^\s)]+)(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?\s*\)/giu,
    requireImageFile: true,
  },
];
const RAW_URL_RE = /https?:\/\/[^\s<>"'`]+/giu;
const IMAGE_PATH_RE = /\.(?:apng|avif|bmp|gif|heic|heif|ico|jpe?g|jp2|png|svg|tiff?|webp)$/iu;
const RAW_URL_TRAILING_PUNCTUATION_RE = /[)\]}>，。！？；：、,.!?;:]+$/u;

function isImageFileUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && IMAGE_PATH_RE.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function overlaps(match, accepted) {
  return accepted.some(item => match.start < item.end && match.end > item.start);
}

function collectMarkdownImages(text) {
  const images = [];
  for (const { pattern, requireImageFile } of MARKDOWN_IMAGE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (requireImageFile && !isImageFileUrl(match[2])) continue;
      const candidate = {
        type: "image",
        start: match.index,
        end: match.index + match[0].length,
        alt: match[1] || "图片",
        url: match[2],
      };
      if (!overlaps(candidate, images)) images.push(candidate);
    }
  }
  return images;
}

function collectRawImageUrls(text, accepted) {
  RAW_URL_RE.lastIndex = 0;
  for (const match of text.matchAll(RAW_URL_RE)) {
    const raw = match[0];
    const url = raw.replace(RAW_URL_TRAILING_PUNCTUATION_RE, "");
    if (!url || !isImageFileUrl(url)) continue;

    const wrapped = text[match.index - 1] === "<"
      && text[match.index + url.length] === ">";
    const candidate = {
      type: "image",
      start: wrapped ? match.index - 1 : match.index,
      end: match.index + url.length + (wrapped ? 1 : 0),
      alt: "图片",
      url,
    };
    if (!overlaps(candidate, accepted)) accepted.push(candidate);
  }
}

export function parseTextMedia(text) {
  const source = String(text || "");
  if (!source) return [];

  const images = collectMarkdownImages(source);
  collectRawImageUrls(source, images);
  images.sort((a, b) => a.start - b.start);

  if (images.length === 0) return [{ type: "text", text: source }];

  const segments = [];
  let cursor = 0;
  for (const image of images) {
    if (image.start > cursor) {
      segments.push({ type: "text", text: source.slice(cursor, image.start) });
    }
    segments.push({ type: "image", url: image.url, alt: image.alt });
    cursor = image.end;
  }
  if (cursor < source.length) {
    segments.push({ type: "text", text: source.slice(cursor) });
  }
  return segments.filter(segment => segment.type !== "text" || segment.text.length > 0);
}

export function renderTextMedia(text, { textClass, imageClass }) {
  return parseTextMedia(text).map(segment => {
    if (segment.type === "text") {
      return segment.text.trim()
        ? `<div class="${textClass}">${esc(segment.text)}</div>`
        : "";
    }

    const url = escAttr(segment.url);
    const alt = escAttr(segment.alt || "图片");
    return `<div class="${imageClass} linked-image">
      <img src="${url}" alt="${alt}" loading="lazy"
        onclick="PawzoChat.openImagePreview(this.src)"
        onerror="this.hidden=true;this.nextElementSibling.hidden=false">
      <a class="linked-image-fallback" href="${url}" target="_blank" rel="noopener noreferrer" hidden>图片加载失败，打开原链接</a>
    </div>`;
  }).join("");
}