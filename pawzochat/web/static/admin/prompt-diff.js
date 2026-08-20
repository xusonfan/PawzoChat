import { esc, fieldLabel } from "./state.js";

function printable(value) {
  if (typeof value === "string") return value || "（空）";
  if (value === undefined) return "（未设置）";
  return JSON.stringify(value, null, 2);
}

export function renderDiff(preview) {
  const changed = (preview.changes || []).filter(persona => persona.fields?.length);
  if (!changed.length) {
    return `<div class="empty">所选批量操作不会改变任何现有配置</div>`;
  }
  return changed.map(persona => `
    <section class="diff-persona">
      <h4>
        <strong>${esc(persona.name)}</strong>
        <span class="muted code" style="font-size:12px;margin-left:8px">${esc(persona.id)}</span>
      </h4>
      ${persona.fields.map(change => `
        <div class="diff-row">
          <strong style="color:var(--text-2);padding-top:8px">${esc(fieldLabel(change.field))}</strong>
          <div class="diff-value">${esc(printable(change.before))}</div>
          <div class="diff-arrow">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
          </div>
          <div class="diff-value after-val">${esc(printable(change.after))}</div>
        </div>
      `).join("")}
    </section>
  `).join("");
}

export function summarizePreview(preview) {
  return `已选择 ${preview.selected_count || 0} 个人物，其中 ${preview.changed_count || 0} 个人物的设定将发生变更`;
}