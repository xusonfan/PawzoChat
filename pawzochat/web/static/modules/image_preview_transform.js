export const IMAGE_PREVIEW_MIN_SCALE = 1;
export const IMAGE_PREVIEW_MAX_SCALE = 5;

export function previewSequence(currentSource, candidates = []) {
  const current = typeof currentSource === "string" ? currentSource.trim() : "";
  const sources = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const source = typeof candidate === "string" ? candidate.trim() : "";
    if (!source || seen.has(source)) continue;
    seen.add(source);
    sources.push(source);
  }
  if (current && !seen.has(current)) sources.unshift(current);
  return {
    sources: sources.length ? sources : (current ? [current] : []),
    index: Math.max(0, sources.indexOf(current)),
  };
}

export function previewSwipeDirection(startPoint, endPoint, scale = 1) {
  if (scale > 1) return 0;
  const deltaX = endPoint.x - startPoint.x;
  const deltaY = endPoint.y - startPoint.y;
  if (Math.abs(deltaX) < 56 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.25) return 0;
  return deltaX < 0 ? 1 : -1;
}

export function clampPreviewView(
  view,
  imageWidth,
  imageHeight,
  viewportWidth,
  viewportHeight,
) {
  const scale = Math.min(
    IMAGE_PREVIEW_MAX_SCALE,
    Math.max(IMAGE_PREVIEW_MIN_SCALE, Number(view.scale) || 1),
  );
  const maxX = Math.max(0, ((imageWidth || 0) * scale - (viewportWidth || 0)) / 2);
  const maxY = Math.max(0, ((imageHeight || 0) * scale - (viewportHeight || 0)) / 2);
  return {
    scale,
    x: maxX === 0 ? 0 : Math.max(-maxX, Math.min(maxX, Number(view.x) || 0)),
    y: maxY === 0 ? 0 : Math.max(-maxY, Math.min(maxY, Number(view.y) || 0)),
  };
}

export function zoomPreviewAt(view, targetScale, point) {
  const scale = Math.min(
    IMAGE_PREVIEW_MAX_SCALE,
    Math.max(IMAGE_PREVIEW_MIN_SCALE, targetScale),
  );
  const ratio = scale / (view.scale || 1);
  return {
    scale,
    x: point.x - (point.x - view.x) * ratio,
    y: point.y - (point.y - view.y) * ratio,
  };
}

export function pinchPreviewView(startView, startCenter, currentCenter, distanceRatio) {
  const scale = Math.min(
    IMAGE_PREVIEW_MAX_SCALE,
    Math.max(IMAGE_PREVIEW_MIN_SCALE, startView.scale * distanceRatio),
  );
  const ratio = scale / startView.scale;
  return {
    scale,
    x: currentCenter.x - (startCenter.x - startView.x) * ratio,
    y: currentCenter.y - (startCenter.y - startView.y) * ratio,
  };
}

export function pointerDistance(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export function pointerCenter(first, second) {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}