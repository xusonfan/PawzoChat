/* PawzoChat — Copyright (C) 2026 iwyxdxl. SPDX-License-Identifier: AGPL-3.0-or-later */
/* Variable-height, keyed chat list. No framework, no offscreen DOM cache. */
export class VirtualMessages {
  constructor(el, renderItem, onScroll) {
    this.el = el;
    this.renderItem = renderItem;
    this.onScroll = onScroll;
    this.items = [];
    this.indices = new Map();
    this.heights = new Map();
    this.offsets = [0];
    this.nodes = new Map();
    this.followBottom = true;
    this.destroyed = false;
    this.frame = 0;
    this.lastScrollTop = el.scrollTop;
    this.expectedScrollTop = null;
    el.classList.add('chat-virtual');
    el.innerHTML = '<button class="chat-history-status" type="button" disabled></button><div class="chat-top-spacer"></div><div class="chat-virtual-rows"></div><div class="chat-bottom-spacer"></div><div class="chat-history-empty" hidden>开始对话吧</div>';
    [this.status, this.top, this.rows, this.bottom, this.empty] = el.children;
    this.scrollHandler = () => {
      const top = el.scrollTop;
      const corrected = this.expectedScrollTop !== null && Math.abs(top - this.expectedScrollTop) < 1;
      if (!corrected) {
        // A small upward gesture must break the pin immediately, even inside
        // the 80px new-message follow zone. Our own anchor corrections must
        // never be interpreted as the user scrolling back toward the bottom.
        if (top < this.lastScrollTop) this.followBottom = false;
        else if (top > this.lastScrollTop) this.followBottom = this.isNearBottom();
      }
      this.expectedScrollTop = null;
      this.lastScrollTop = top;
      this.scheduleMeasure();
    };
    this.wheelHandler = event => { if (event.deltaY < 0) this.followBottom = false; };
    this.touchStartHandler = event => { this.touchY = event.touches[0]?.clientY; };
    this.touchMoveHandler = event => {
      const y = event.touches[0]?.clientY;
      if (y > this.touchY) this.followBottom = false;
      this.touchY = y;
    };
    this.keyHandler = event => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) this.followBottom = false;
    };
    el.addEventListener('scroll', this.scrollHandler, { passive: true });
    el.addEventListener('wheel', this.wheelHandler, { passive: true });
    el.addEventListener('touchstart', this.touchStartHandler, { passive: true });
    el.addEventListener('touchmove', this.touchMoveHandler, { passive: true });
    el.addEventListener('keydown', this.keyHandler);
    this.width = el.clientWidth;
    this.observer = new ResizeObserver(() => this.scheduleMeasure());
    this.observer.observe(el);
  }

  isNearBottom() {
    return this.el.scrollHeight - this.el.clientHeight - this.el.scrollTop <= 80;
  }

  base() { return this.status.offsetHeight + (parseFloat(getComputedStyle(this.el).paddingTop) || 0); }

  indexAt(y) {
    let lo = 0, hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.offsets[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, Math.max(0, this.items.length - 1));
  }

  capture() {
    const y = this.el.scrollTop - this.base();
    const index = this.indexAt(Math.max(0, y));
    return { key: this.items[index]?._key, offset: y - this.offsets[index] };
  }

  anchorTop(anchor) {
    const index = this.indices.get(anchor?.key);
    return index === undefined ? this.el.scrollTop : this.base() + this.offsets[index] + anchor.offset;
  }

  writeScroll(top) {
    if (Math.abs(this.el.scrollTop - top) > 0.5) {
      this.el.scrollTop = top;
    }
    if (Math.abs(this.el.scrollTop - this.lastScrollTop) > 0.5) {
      this.expectedScrollTop = this.el.scrollTop; // actual value after browser clamping
      this.lastScrollTop = this.el.scrollTop;
    }
  }

  rebuild() {
    this.offsets = [0];
    this.indices.clear();
    for (let i = 0; i < this.items.length; i++) {
      const key = this.items[i]._key;
      this.indices.set(key, i);
      this.offsets.push(this.offsets[i] + (this.heights.get(key) ?? 88));
    }
  }

  setItems(items, { bottom = this.followBottom } = {}) {
    const anchor = this.capture();
    this.items = items;
    this.empty.hidden = items.length !== 0;
    this.rebuild();
    this.followBottom = bottom;
    this.render(anchor, bottom);
    this.scheduleMeasure();
  }

  range(top) {
    const y = Math.max(0, top - this.base());
    const overscan = this.el.clientHeight;
    const start = this.indexAt(Math.max(0, y - overscan));
    const end = Math.min(this.items.length, start + 200, this.indexAt(y + 2 * overscan) + 1);
    return [start, end];
  }

  spacers(start, end) {
    this.top.style.height = `${this.offsets[start] || 0}px`;
    this.bottom.style.height = `${this.offsets[this.items.length] - (this.offsets[end] || 0)}px`;
  }

  mount(start, end) {
    const keys = new Set(this.items.slice(start, end).map(m => m._key));
    for (const [key, node] of this.nodes) {
      if (!keys.has(key)) {
        this.observer.unobserve(node);
        node.remove();
        this.nodes.delete(key);
      }
    }
    let cursor = this.rows.firstElementChild;
    for (let i = start; i < end; i++) {
      const item = this.items[i], previous = this.items[i - 1];
      let node = this.nodes.get(item._key);
      if (!node) {
        node = document.createElement('div');
        node.className = 'chat-virtual-item';
        node.dataset.messageKey = item._key;
        this.nodes.set(item._key, node);
        this.observer.observe(node);
      }
      if (node.message !== item || node.previousTime !== previous?.timestamp) {
        node.innerHTML = this.renderItem(item, previous);
        node.message = item;
        node.previousTime = previous?.timestamp;
      }
      if (node !== cursor) this.rows.insertBefore(node, cursor);
      cursor = node.nextElementSibling;
    }
  }

  measure() {
    let changed = false;
    for (const [key, node] of this.nodes) {
      const height = node.getBoundingClientRect().height;
      if (height > 0 && Math.abs((this.heights.get(key) ?? 88) - height) > 0.25) {
        this.heights.set(key, height);
        changed = true;
      }
    }
    if (changed) this.rebuild();
    return changed;
  }

  render(anchor = this.capture(), bottom = this.followBottom) {
    if (this.destroyed) return;
    if (this.width !== this.el.clientWidth) {
      this.width = this.el.clientWidth;
      this.heights.clear();
      this.rebuild();
    }
    // Mount, measure and compensate BEFORE painting. In particular, don't
    // render one frame with estimated spacers and repair it in the next RO
    // callback: that makes newly mounted rows visibly jump on every scroll.
    // Reuse the same anchor throughout all passes, not an intermediate layout.
    this.measure();
    for (let pass = 0; pass < 3; pass++) {
      const paddingBottom = parseFloat(getComputedStyle(this.el).paddingBottom) || 0;
      const target = bottom ? this.base() + this.offsets[this.items.length] - this.el.clientHeight + paddingBottom : this.anchorTop(anchor);
      const [start, end] = this.range(target);
      this.mount(start, end);
      this.measure();
      this.spacers(start, end);
      this.writeScroll(bottom ? Math.max(0, this.el.scrollHeight - this.el.clientHeight) : this.anchorTop(anchor));
      const [nextStart, nextEnd] = this.range(this.el.scrollTop);
      if (start === nextStart && end === nextEnd) return;
    }
    // Huge rows may need another buffer pass, but the visible anchor is
    // already correct; never spend an unbounded amount of work in one frame.
    this.scheduleMeasure();
  }

  scheduleMeasure() {
    if (this.destroyed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.destroyed) return;
      this.render();
      this.onScroll?.();
    });
  }

  scrollToBottom() {
    this.followBottom = true;
    this.render(this.capture(), true);
  }

  setStatus(text, retry) {
    this.status.textContent = text;
    this.status.disabled = !retry;
    this.status.onclick = retry || null;
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.el.removeEventListener('scroll', this.scrollHandler);
    this.el.removeEventListener('wheel', this.wheelHandler);
    this.el.removeEventListener('touchstart', this.touchStartHandler);
    this.el.removeEventListener('touchmove', this.touchMoveHandler);
    this.el.removeEventListener('keydown', this.keyHandler);
    this.status.onclick = null;
    this.nodes.clear();
    this.rows.replaceChildren();
    this.heights.clear();
    this.indices.clear();
    this.items = [];
    this.offsets = [0];
    this.onScroll = null;
  }
}
