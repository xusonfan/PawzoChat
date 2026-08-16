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
import { imageLayoutAttributes } from "./image_layout_cache.js";

const MARKDOWN_IMAGE_PATTERNS = [
  {
    pattern: /!\[([^\]\r\n]*)\]\(\s*([^\s)]+)(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?\s*\)/giu,
    requireImageFile: false,
  },
  {
    pattern: /\[((?:图片|图像|照片|image|img|picture)(?:链接|地址|url)?)\]\(\s*([^\s)]+)(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?\s*\)/giu,
    requireImageFile: false,
  },
  {
    pattern: /\[([^\]\r\n]+)\]\(\s*([^\s)]+)(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?\s*\)/giu,
    requireImageFile: true,
  },
];
const RAW_URL_RE = /https?:\/\/[^\s<>"'`]+/giu;
const ANGLE_IMAGE_PATH_RE = /<([^<>\s]+)>/gu;
const IMAGE_PATH_RE = /\.(?:apng|avif|bmp|gif|heic|heif|ico|jpe?g|jp2|png|svg|tiff?|webp)$/iu;
const RAW_URL_TRAILING_PUNCTUATION_RE = /[)\]}>，。！？；：、,.!?;:]+$/u;

function isAllowedImageReference(value) {
  try {
    const url = new URL(value, "https://pawzochat.invalid/");
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return false;
  }
}

function isImageFileUrl(value) {
  if (!isAllowedImageReference(value)) return false;
  try {
    const url = new URL(value, "https://pawzochat.invalid/");
    return IMAGE_PATH_RE.test(url.pathname);
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
      if (!isAllowedImageReference(match[2])) continue;
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

function collectAngleImagePaths(text, accepted) {
  ANGLE_IMAGE_PATH_RE.lastIndex = 0;
  for (const match of text.matchAll(ANGLE_IMAGE_PATH_RE)) {
    const url = match[1];
    if (!isImageFileUrl(url)) continue;
    const candidate = {
      type: "image",
      start: match.index,
      end: match.index + match[0].length,
      alt: "图片",
      url,
    };
    if (!overlaps(candidate, accepted)) accepted.push(candidate);
  }
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
  collectAngleImagePaths(source, images);
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

export function summarizeConversationMessage(message, maxLength = 60) {
  if (!message) return "";

  let summary = String(message.text || "");
  const segments = parseTextMedia(summary);
  if (segments.some(segment => segment.type === "image")) {
    summary = segments.map(segment => (
      segment.type === "image" ? "[图片]" : segment.text
    )).join("").trim();
  }

  if (message.has_image && !summary.includes("[图片]")) {
    summary = summary.trim();
    summary = summary ? `${summary} [图片]` : "[图片]";
  }
  return summary.slice(0, maxLength);
}

/**
 * Drop newlines that only separate text from adjacent media segments.
 * Keeps intentional paragraph breaks inside text (e.g. "a\\n\\nb"); only
 * strips leading/trailing \\n at media boundaries so "text\\n[image]" does
 * not emit a blank <br> line before the thumbnail.
 */
function normalizeMediaBoundaryNewlines(segments) {
  return segments.map((segment, index) => {
    if (segment.type !== "text") return segment;

    let text = segment.text;
    const prev = segments[index - 1];
    const next = segments[index + 1];
    if (prev && prev.type === "image") text = text.replace(/^\r?\n+/, "");
    if (next && next.type === "image") text = text.replace(/\r?\n+$/, "");
    if (!text) return null;
    return text === segment.text ? segment : { type: "text", text };
  }).filter(Boolean);
}

/**
 * Render parseTextMedia segments to safe HTML.
 *
 * Options (all optional; defaults keep chat/history-edit behaviour):
 * - textClass / imageClass: wrapper classes
 * - inline: no text wrappers; images use <span> (for moments comments)
 * - preserveNewlines: convert \n to <br> in text segments
 * - trimMediaBoundaryNewlines: strip newlines at text↔image edges (moments)
 * - stopPropagation: stop click bubbling before openImagePreview / fallback link
 * - imageMaxWidth / imageMaxHeight: reserve the cached rendered image footprint
 */
export function renderTextMedia(text, {
  textClass,
  imageClass,
  inline = false,
  preserveNewlines = false,
  trimMediaBoundaryNewlines = false,
  stopPropagation = false,
  imageMaxWidth = 240,
  imageMaxHeight = imageMaxWidth,
} = {}) {
  const clickPrefix = stopPropagation ? "event.stopPropagation();" : "";
  const fallbackClick = stopPropagation
    ? ` onclick="event.stopPropagation()"`
    : "";
  const wrapTag = inline ? "span" : "div";

  let segments = parseTextMedia(text);
  if (trimMediaBoundaryNewlines) {
    segments = normalizeMediaBoundaryNewlines(segments);
  }

  return segments.map(segment => {
    if (segment.type === "text") {
      let body = esc(segment.text);
      if (preserveNewlines) body = body.replace(/\n/g, "<br>");
      if (inline) return body;
      return segment.text.trim()
        ? `<div class="${textClass}">${body}</div>`
        : "";
    }

    const url = escAttr(segment.url);
    const alt = escAttr(segment.alt || "图片");
    const layout = imageLayoutAttributes(segment.url, {
      maxWidth: imageMaxWidth,
      maxHeight: imageMaxHeight,
    });
    // Compact markup: leading whitespace text nodes inside inline-block +
    // block img create an extra empty line above the thumbnail.
    return `<${wrapTag} class="${imageClass} linked-image">`
      + `<img src="${url}" alt="${alt}" loading="lazy" data-message-media${layout}`
      + ` onload="PawzoChat.rememberImageLayout(this)"`
      + ` onclick="${clickPrefix}PawzoChat.openImagePreview(this.src)"`
      + ` onerror="this.hidden=true;this.nextElementSibling.hidden=false">`
      + `<a class="linked-image-fallback" href="${url}" target="_blank" rel="noopener noreferrer" hidden${fallbackClick}>图片加载失败，打开原链接</a>`
      + `</${wrapTag}>`;
  }).join("");
}