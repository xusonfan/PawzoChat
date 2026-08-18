import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(join(
  __dirname,
  "../pawzochat/web/static/modules/image_preview_transform.js",
)).href;
const {
  clampPreviewView,
  pinchPreviewView,
  pointerCenter,
  pointerDistance,
  previewSequence,
  previewSwipeDirection,
  zoomPreviewAt,
} = await import(moduleUrl);

assert.deepEqual(
  previewSequence("second.png", ["first.png", "second.png", "first.png", "third.png"]),
  { sources: ["first.png", "second.png", "third.png"], index: 1 },
  "预览序列应去重并定位当前图片",
);
assert.deepEqual(
  previewSequence("current.png", []),
  { sources: ["current.png"], index: 0 },
  "没有同组图片时应保留当前图片",
);

assert.equal(
  previewSwipeDirection({ x: 80, y: 0 }, { x: -10, y: 8 }, 1),
  1,
  "向左滑动应切换到下一张",
);
assert.equal(
  previewSwipeDirection({ x: -20, y: 0 }, { x: 60, y: 5 }, 1),
  -1,
  "向右滑动应切换到上一张",
);
assert.equal(
  previewSwipeDirection({ x: 80, y: 0 }, { x: -10, y: 8 }, 2),
  0,
  "图片放大后横向手势应保留给画面拖动",
);
assert.equal(
  previewSwipeDirection({ x: 0, y: 0 }, { x: 30, y: 90 }, 1),
  0,
  "纵向或短距离手势不应误触图片切换",
);

assert.equal(pointerDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
assert.deepEqual(
  pointerCenter({ x: -10, y: 20 }, { x: 30, y: 40 }),
  { x: 10, y: 30 },
);

const zoomed = zoomPreviewAt(
  { scale: 1, x: 0, y: 0 },
  2,
  { x: 80, y: -30 },
);
assert.deepEqual(zoomed, { scale: 2, x: -80, y: 30 }, "缩放应保持手势焦点不漂移");

const pinched = pinchPreviewView(
  { scale: 2, x: 10, y: 20 },
  { x: 0, y: 0 },
  { x: 15, y: -5 },
  1.5,
);
assert.deepEqual(
  pinched,
  { scale: 3, x: 30, y: 25 },
  "双指中心移动应同时驱动缩放和平移",
);

assert.deepEqual(
  clampPreviewView(
    { scale: 9, x: 999, y: -999 },
    300,
    200,
    400,
    500,
  ),
  { scale: 5, x: 550, y: -250 },
  "视图应限制最大倍率和可拖动边界",
);
assert.deepEqual(
  clampPreviewView(
    { scale: 0.2, x: 40, y: -20 },
    300,
    200,
    400,
    500,
  ),
  { scale: 1, x: 0, y: 0 },
  "缩回原始倍率时应自动居中复位",
);

console.log("image preview transform tests passed");