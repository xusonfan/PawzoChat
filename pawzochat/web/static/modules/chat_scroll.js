/*!
 * PawzoChat - deterministic chat bottom anchoring around async media layout.
 */

export function createChatBottomAnchor({
  threshold = 80,
  requestFrame = callback => requestAnimationFrame(callback),
  cancelFrame = frame => cancelAnimationFrame(frame),
  createResizeObserver = typeof ResizeObserver !== "undefined"
    ? callback => new ResizeObserver(callback)
    : null,
} = {}) {
  let el = null;
  let followBottom = true;
  let initialAnchor = false;
  let epoch = 0;
  let bindingVersion = 0;
  let userScrollVersion = 0;
  let alignFrame = 0;
  let scrollCleanup = null;
  let disconnectObserver = null;
  let resizeObserver = null;
  let mediaCleanups = [];

  const isNearBottom = target => (
    target.scrollTop + target.clientHeight >= target.scrollHeight - threshold
  );

  function cancelFrames() {
    if (alignFrame) cancelFrame(alignFrame);
    alignFrame = 0;
  }

  function clearMedia() {
    for (const cleanup of mediaCleanups.splice(0)) cleanup();
  }

  function clearResizeObserver() {
    resizeObserver?.disconnect();
    resizeObserver = null;
  }

  function watchLayout(root, target = el, targetEpoch = epoch) {
    if (!resizeObserver || !root || !target || el !== target || epoch !== targetEpoch) return;
    const roots = root === target ? Array.from(root.children || []) : [root];
    for (const observedRoot of roots) resizeObserver.observe(observedRoot);
  }

  function scrollToBottom(target = el) {
    if (!target || el !== target) return false;
    target.scrollTop = target.scrollHeight;
    return true;
  }

  function shouldAnchorMedia(target = el) {
    return !!target && el === target
      && (initialAnchor || followBottom || isNearBottom(target));
  }

  function scheduleBottom(target = el) {
    if (!shouldAnchorMedia(target) || alignFrame) return;
    const targetEpoch = epoch;
    alignFrame = requestFrame(() => {
      alignFrame = 0;
      if (el === target && epoch === targetEpoch && shouldAnchorMedia(target)) {
        scrollToBottom(target);
      }
    });
  }

  function bind(target, { initial = true, lifecycleRoot = null } = {}) {
    if (scrollCleanup) scrollCleanup();
    if (disconnectObserver) disconnectObserver.disconnect();
    disconnectObserver = null;
    clearResizeObserver();
    clearMedia();
    cancelFrames();
    epoch += 1;
    bindingVersion += 1;
    el = target;
    followBottom = true;
    initialAnchor = initial;
    userScrollVersion = 0;
    const targetBindingVersion = bindingVersion;

    const onScroll = () => {
      if (el !== target) return;
      userScrollVersion += 1;
      const near = isNearBottom(target);
      followBottom = near;
      if (!near) initialAnchor = false;
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    scrollCleanup = () => target.removeEventListener("scroll", onScroll);

    if (createResizeObserver) {
      resizeObserver = createResizeObserver(() => {
        if (el === target && bindingVersion === targetBindingVersion) scheduleBottom(target);
      });
    }

    if (lifecycleRoot && typeof MutationObserver !== "undefined") {
      disconnectObserver = new MutationObserver(() => {
        if (el === target && !target.isConnected) dispose();
      });
      disconnectObserver.observe(lifecycleRoot, { childList: true, subtree: true });
    }
    return epoch;
  }

  function beginRender(target = el) {
    if (!target || el !== target) return null;
    const snapshot = {
      target,
      follow: initialAnchor || followBottom,
      scrollTop: target.scrollTop,
      userScrollVersion,
      epoch: ++epoch,
    };
    clearMedia();
    resizeObserver?.disconnect();
    cancelFrames();
    return snapshot;
  }

  function watchMedia(root, target = el, targetEpoch = epoch) {
    if (!root || !target || el !== target || epoch !== targetEpoch) return;
    for (const image of root.querySelectorAll("img[data-message-media]")) {
      let active = true;
      let cachedFrame = 0;
      const cleanup = () => {
        if (!active) return;
        active = false;
        if (cachedFrame) cancelFrame(cachedFrame);
        image.removeEventListener("load", settle);
        image.removeEventListener("error", settle);
      };
      const settle = () => {
        cleanup();
        if (el === target && epoch === targetEpoch) scheduleBottom(target);
      };
      mediaCleanups.push(cleanup);
      if (image.complete) {
        cachedFrame = requestFrame(() => {
          cachedFrame = 0;
          settle();
        });
      } else {
        image.addEventListener("load", settle, { once: true });
        image.addEventListener("error", settle, { once: true });
      }
    }
  }

  function finishRender(snapshot, root = snapshot?.target) {
    if (!snapshot || el !== snapshot.target || epoch !== snapshot.epoch) return;
    const userMoved = userScrollVersion !== snapshot.userScrollVersion;
    if (!userMoved) {
      followBottom = snapshot.follow;
      if (snapshot.follow) scrollToBottom(snapshot.target);
      else snapshot.target.scrollTop = snapshot.scrollTop;
    }
    watchLayout(root, snapshot.target, snapshot.epoch);
    watchMedia(root, snapshot.target, snapshot.epoch);
  }

  function scrollAfterInsert(target = el, root = target?.lastElementChild) {
    if (!target || el !== target) return;
    if (followBottom || initialAnchor || isNearBottom(target)) scrollToBottom(target);
    scheduleBottom(target);
    if (root) {
      watchLayout(root, target, epoch);
      watchMedia(root, target, epoch);
    }
  }

  function followsBottom(target = el) {
    return !!target && el === target && (initialAnchor || followBottom || isNearBottom(target));
  }

  function dispose() {
    if (scrollCleanup) scrollCleanup();
    scrollCleanup = null;
    if (disconnectObserver) disconnectObserver.disconnect();
    disconnectObserver = null;
    clearResizeObserver();
    clearMedia();
    cancelFrames();
    epoch += 1;
    bindingVersion += 1;
    el = null;
    initialAnchor = false;
    followBottom = false;
  }

  return {
    beginRender,
    bind,
    dispose,
    finishRender,
    followsBottom,
    isNearBottom,
    scheduleBottom,
    scrollAfterInsert,
    scrollToBottom,
    watchMedia,
  };
}