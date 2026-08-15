import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { ownsConversationListTarget } = await import(pathToFileURL(join(
  __dirname,
  "../pawzochat/web/static/modules/conversation_list_ownership.js",
)).href + `?t=${Date.now()}`);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function target(html = "") {
  return { isConnected: true, innerHTML: html };
}

async function runDelayedListPaint({ desktop }) {
  const contentTarget = target('<div id="conv-list-page"></div>');
  const sidebarTarget = target(desktop ? '<div id="conv-list-page"></div>' : "");
  const listTarget = desktop ? sidebarTarget : contentTarget;
  const state = { currentTab: "chat", pageStack: [], conversations: [] };
  const response = deferred();

  const oldListRequest = (async () => {
    const conversations = await response.promise;
    state.conversations = conversations;
    const owned = ownsConversationListTarget({
      target: listTarget,
      desktop,
      currentDesktop: desktop,
      currentTab: state.currentTab,
      pageDepth: state.pageStack.length,
      contentTarget,
      sidebarTarget,
    });
    if (owned) listTarget.innerHTML = '<div id="conv-list-page">fresh</div>';
    return owned;
  })();

  // One ordinary click performs the complete state transition synchronously.
  state.pageStack.push({ name: "chatWindow", data: { personaId: "cat" } });
  contentTarget.innerHTML = '<div class="chat-container"><div id="chat-msgs"></div></div>';

  response.resolve([{ persona_id: "cat" }]);
  const painted = await oldListRequest;
  return { contentTarget, sidebarTarget, state, painted };
}

// Narrow screen: the stale request may merge state, but no longer owns content.
const mobile = await runDelayedListPaint({ desktop: false });
assert.equal(mobile.painted, false);
assert.equal(mobile.state.pageStack.at(-1).name, "chatWindow");
assert.match(mobile.contentTarget.innerHTML, /id="chat-msgs"/);
assert.doesNotMatch(mobile.contentTarget.innerHTML, /id="conv-list-page"/);
assert.deepEqual(mobile.state.conversations, [{ persona_id: "cat" }]);

// Desktop: the sidebar remains the list owner while main content stays chat.
const desktop = await runDelayedListPaint({ desktop: true });
assert.equal(desktop.painted, true);
assert.equal(desktop.state.pageStack.at(-1).name, "chatWindow");
assert.match(desktop.contentTarget.innerHTML, /id="chat-msgs"/);
assert.match(desktop.sidebarTarget.innerHTML, /id="conv-list-page"/);

// A request from the old layout or a detached target never paints.
const detached = target();
detached.isConnected = false;
assert.equal(ownsConversationListTarget({
  target: detached,
  desktop: true,
  currentDesktop: true,
  currentTab: "chat",
  pageDepth: 0,
  contentTarget: target(),
  sidebarTarget: detached,
}), false);
assert.equal(ownsConversationListTarget({
  target: desktop.sidebarTarget,
  desktop: true,
  currentDesktop: false,
  currentTab: "chat",
  pageDepth: 0,
  contentTarget: desktop.contentTarget,
  sidebarTarget: desktop.sidebarTarget,
}), false);

console.log("conversation list ownership race tests passed");