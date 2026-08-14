/*!
 * Pure HTML builders for moment card chrome (meta row + actions pop).
 * Kept free of page/state side effects so layout order can be unit-tested.
 */
import { esc, iconHtml } from "./utils.js";

/**
 * Actions popup buttons. Order: edit (owner only) → like → comment.
 * Delete is intentionally omitted (lives next to the timestamp).
 */
export function buildMomentActionsPopHtml(mid, { canEdit = false, liked = false } = {}) {
  const id = esc(mid);
  const parts = [];
  if (canEdit === true) {
    parts.push(`
      <button class="map-btn" type="button" onclick="PawzoChat.momentsEdit('${id}')">
        ${iconHtml("ri-edit-line")}<span>编辑</span>
      </button>`);
  }
  parts.push(`
    <button class="map-btn" type="button" onclick="PawzoChat.momentsLikeToggle('${id}')">
      ${iconHtml(liked ? "ri-heart-fill" : "ri-heart-line")}<span>${liked ? "已赞" : "赞"}</span>
    </button>`);
  parts.push(`
    <button class="map-btn" type="button" onclick="PawzoChat.momentsOpenComposer('${id}')">
      ${iconHtml("ri-chat-3-line")}<span>评论</span>
    </button>`);
  return parts.join(`
    <span class="map-divider"></span>`);
}

/**
 * Meta row: time (+ optional trash for owner) on the left, "…" menu on the right.
 */
export function buildMomentMetaHtml(mid, time, { canDelete = false } = {}) {
  const id = esc(mid);
  const delBtn = canDelete === true
    ? `<button type="button" class="moments-delete" title="删除" aria-label="删除"
         onclick="event.stopPropagation();PawzoChat.momentsDelete('${id}')">
         ${iconHtml("ri-delete-bin-line")}
       </button>`
    : "";
  return `
        <div class="moments-meta">
          <div class="moments-meta-start">
            <span class="moments-time">${esc(time)}</span>
            ${delBtn}
          </div>
          <button type="button" class="moments-more" title="操作" aria-label="操作"
            onclick="event.stopPropagation();PawzoChat.momentsItemMenu(event, '${id}')">
            ${iconHtml("ri-more-fill")}
          </button>
        </div>`;
}