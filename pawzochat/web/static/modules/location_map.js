/*!
 * PawzoChat - lightweight slippy-map geometry for location sharing
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const TILE_SIZE = 256;
const MAX_LATITUDE = 85.05112878;

function clampLatitude(latitude) {
  return Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, Number(latitude) || 0));
}

function wrapLongitude(longitude) {
  return ((Number(longitude) + 180) % 360 + 360) % 360 - 180;
}

function coordinateToWorld(latitude, longitude, zoom) {
  const scale = 2 ** zoom;
  const lat = clampLatitude(latitude) * Math.PI / 180;
  return {
    x: ((wrapLongitude(longitude) + 180) / 360) * scale * TILE_SIZE,
    y: (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * scale * TILE_SIZE,
  };
}

function worldToCoordinate(x, y, zoom) {
  const scale = 2 ** zoom;
  const worldSize = scale * TILE_SIZE;
  const longitude = wrapLongitude(x / worldSize * 360 - 180);
  const mercatorY = Math.PI * (1 - 2 * y / worldSize);
  const latitude = Math.atan(Math.sinh(mercatorY)) * 180 / Math.PI;
  return { latitude: clampLatitude(latitude), longitude };
}

export function coordinateAtMapPoint(center, zoom, point, size) {
  const world = coordinateToWorld(center.latitude, center.longitude, zoom);
  return worldToCoordinate(
    world.x + point.x - size.width / 2,
    world.y + point.y - size.height / 2,
    zoom,
  );
}

export function mapTiles(center, zoom, size) {
  const world = coordinateToWorld(center.latitude, center.longitude, zoom);
  const scale = 2 ** zoom;
  const left = world.x - size.width / 2;
  const top = world.y - size.height / 2;
  const startX = Math.floor(left / TILE_SIZE);
  const endX = Math.floor((left + size.width) / TILE_SIZE);
  const startY = Math.max(0, Math.floor(top / TILE_SIZE));
  const endY = Math.min(scale - 1, Math.floor((top + size.height) / TILE_SIZE));
  const tiles = [];

  for (let tileY = startY; tileY <= endY; tileY += 1) {
    for (let tileX = startX; tileX <= endX; tileX += 1) {
      const wrappedX = ((tileX % scale) + scale) % scale;
      tiles.push({
        x: tileX * TILE_SIZE - left,
        y: tileY * TILE_SIZE - top,
        url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${tileY}.png`,
      });
    }
  }
  return tiles;
}

export function clampMapZoom(value) {
  return Math.max(3, Math.min(19, Math.round(Number(value) || 15)));
}