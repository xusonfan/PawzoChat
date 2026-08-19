/**
 * Regression tests for detail -> chat return-state navigation.
 * Run: node tests/test_navigation_return.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  toggle(value, force) {
    if (force === true) this.values.add(value);
    else if (force === false) this.values.delete(value);
    else if (this.values.has(value)) this.values.delete(value);
    else this.values.add(value);
  }
  contains(value) { return this.values.has(value); }
}

function fakeElement() {
  return {
    classList: new FakeClassList(),
    style: {},
    dataset: {},
    innerHTML: "",
    textContent: "",
    scrollTop: 0,
    firstChild: null,
  };
}

const elements = new Map([
  ["top-bar", fakeElement()],
  ["content-area", fakeElement()],
  ["sidebar-body", fakeElement()],
  ["tab-bar", fakeElement()],
]);
const tabs = ["chat", "contacts", "discover"].map(name => {
  const element = fakeElement();
  element.dataset.tab = name;
  return element;
});

globalThis.window = {
  matchMedia: () => ({ matches: true, addEventListener() {} }),
  addEventListener() {},
};
globalThis.requestAnimationFrame = callback => {
  callback();
  return 1;
};
globalThis.document = {
  getElementById: id => elements.get(id) || null,
  querySelectorAll: selector => selector === ".tab" ? tabs : [],
};
globalThis.history = { state: null };
globalThis.location = { href: "http://localhost/" };

const __dirname = dirname(fileURLToPath(import.meta.url));
const moduleUrl = name => pathToFileURL(
  join(__dirname, `../pawzochat/web/static/modules/${name}.js`),
).href;
const navigationSource = await readFile(
  join(__dirname, "../pawzochat/web/static/modules/navigation.js"),
  "utf8",
);
const indexTemplateSource = await readFile(
  join(__dirname, "../pawzochat/web/templates/index.html"),
  "utf8",
);
const contactsSource = await readFile(
  join(__dirname, "../pawzochat/web/static/modules/contacts.js"),
  "utf8",
);
const personaWriterSource = await readFile(
  join(__dirname, "../pawzochat/web/static/modules/persona_writer.js"),
  "utf8",
);
assert.match(navigationSource, /topBarMomentsCoverOverlay:[\s\S]*?topBarCoverHidden:/);
assert.match(
  personaWriterSource,
  /pushPage\("personaEdit", \{[\s\S]*?personaId: r\.data\.id,[\s\S]*?openDetailAfterSave: true/,
  "人设编写助手创建角色后应声明保存完成后打开角色名片",
);
assert.match(
  contactsSource,
  /if \(openDetailAfterSave\) \{[\s\S]*?switchTab\("contacts"\);[\s\S]*?pushPage\("personaDetail", \{ personaId: savedPersonaId \}\)/,
  "角色设置保存完成后应清理旧页面栈并打开新角色名片",
);
assert.match(
  navigationSource,
  /const steps = Math\.max\(0, _historyIndex - targetIndex\)/,
  "同一页面索引的覆盖层返回不能额外弹出当前页面",
);
assert.match(
  navigationSource,
  /function _initRootBackGuard\(\)[\s\S]*?_isStandaloneApp\(\)[\s\S]*?_writeBrowserRoute\("replace"\);[\s\S]*?_writeBrowserRoute\("push"\);/,
  "独立 PWA 的移动端根页面应建立返回键保护层",
);
assert.match(
  indexTemplateSource,
  /display-mode: standalone[\s\S]*?rootGuard: true[\s\S]*?history\.replaceState[\s\S]*?history\.pushState/,
  "冷启动应在主应用模块加载前同步建立根页面返回保护层",
);
assert.match(
  navigationSource,
  /const _bootstrapRoute = history\.state\?\.\[_historyKey\][\s\S]*?_bootstrapRoute\?\.rootGuard/,
  "导航模块应接管冷启动阶段已经建立的返回保护层",
);
assert.match(
  navigationSource,
  /state\.pageStack\.length === 0[\s\S]*?targetIndex === 0[\s\S]*?history\.forward\(\);/,
  "根页面消费系统返回后应回到既有保护层，持续避免退出应用",
);
assert.doesNotMatch(
  navigationSource,
  /if \(isDesktop\(\) \|\| state\.pageStack\.length === 0\) return;/,
  "根页面的 popstate 不能在恢复返回键保护前提前结束",
);
assert.match(
  navigationSource,
  /classList\.toggle\("moments-cover-overlay", !!chrome\.topBarMomentsCoverOverlay\)[\s\S]*?classList\.toggle\("is-cover-hidden", !!chrome\.topBarCoverHidden\)/,
  "返回标签页时应完整恢复朋友圈顶部栏状态",
);
const { state } = await import(moduleUrl("state"));
const {
  goBack,
  navigateToPage,
  pushPage,
  registerPageRenderer,
  registerTabRenderer,
} = await import(moduleUrl("navigation"));

for (const tab of ["chat", "contacts", "discover"]) {
  registerTabRenderer(tab, () => {});
}
const rendered = [];
for (const page of [
  "chatWindow",
  "personaDetail",
  "momentsList",
  "personaMoments",
  "momentDetail",
]) {
  registerPageRenderer(page, data => rendered.push([page, data]));
}

function page(name, personaId) {
  return { name, data: personaId ? { personaId } : {} };
}

// 聊天列表 -> 聊天 -> 资料 -> 发消息：返回栈里折叠旧聊天页，避免 chat/detail 循环。
state.currentTab = "chat";
state.pageStack = [page("chatWindow", "cat"), page("personaDetail", "cat")];
navigateToPage("chat", "chatWindow", { personaId: "cat" }, { collapsePreviousTarget: true });
assert.deepEqual(state.pageStack[0].returnState.pages, [page("personaDetail", "cat")]);
goBack();
assert.deepEqual(state.pageStack, [page("personaDetail", "cat")]);
goBack();
assert.deepEqual(state.pageStack, []);
assert.equal(state.currentTab, "chat");

// 联系人资料保留联系人来源，二次返回落回联系人根页。
state.currentTab = "contacts";
state.pageStack = [page("personaDetail", "cat")];
navigateToPage("chat", "chatWindow", { personaId: "cat" }, { collapsePreviousTarget: true });
goBack();
assert.equal(state.currentTab, "contacts");
assert.deepEqual(state.pageStack, [page("personaDetail", "cat")]);
goBack();
assert.deepEqual(state.pageStack, []);

// 朋友圈资料保留朋友圈页面，资料返回后继续返回朋友圈而非聊天。
state.currentTab = "discover";
state.pageStack = [page("momentsList"), page("personaDetail", "cat")];
navigateToPage("chat", "chatWindow", { personaId: "cat" }, { collapsePreviousTarget: true });
goBack();
assert.equal(state.currentTab, "discover");
assert.deepEqual(state.pageStack, [page("momentsList"), page("personaDetail", "cat")]);
goBack();
assert.deepEqual(state.pageStack, [page("momentsList")]);

// 详细资料 -> 个人朋友圈 -> 详情：逐级返回资料页，不形成循环。
state.currentTab = "contacts";
state.pageStack = [];
pushPage("personaDetail", { personaId: "cat" });
pushPage("personaMoments", { personaId: "cat" });
pushPage("momentDetail", { momentId: "mom_1", personaId: "cat" });
assert.deepEqual(
  state.pageStack.map(p => p.name),
  ["personaDetail", "personaMoments", "momentDetail"],
);
goBack();
assert.deepEqual(
  state.pageStack.map(p => p.name),
  ["personaDetail", "personaMoments"],
);
assert.equal(state.pageStack[1].data.personaId, "cat");
goBack();
assert.deepEqual(
  state.pageStack.map(p => p.name),
  ["personaDetail"],
);
assert.equal(state.pageStack[0].data.personaId, "cat");
goBack();
assert.deepEqual(state.pageStack, []);
assert.equal(state.currentTab, "contacts");

// 从聊天进入资料再进个人朋友圈：返回仍落回聊天。
state.currentTab = "chat";
state.pageStack = [page("chatWindow", "cat")];
pushPage("personaDetail", { personaId: "cat" });
pushPage("personaMoments", { personaId: "cat" });
goBack();
assert.deepEqual(
  state.pageStack.map(p => p.name),
  ["chatWindow", "personaDetail"],
);
goBack();
assert.deepEqual(
  state.pageStack.map(p => p.name),
  ["chatWindow"],
);

// 从全局朋友圈进资料再进个人朋友圈：返回保持 discover 链。
state.currentTab = "discover";
state.pageStack = [page("momentsList")];
pushPage("personaDetail", { personaId: "cat" });
pushPage("personaMoments", { personaId: "cat" });
goBack();
assert.equal(state.currentTab, "discover");
assert.deepEqual(
  state.pageStack.map(p => p.name),
  ["momentsList", "personaDetail"],
);
goBack();
assert.deepEqual(
  state.pageStack.map(p => p.name),
  ["momentsList"],
);

// 朋友圈进入名片后返回：等待异步列表渲染完成，再恢复原滚动位置。
let finishMomentsRender;
registerPageRenderer("momentsList", () => new Promise(resolve => {
  finishMomentsRender = resolve;
}));
state.currentTab = "discover";
state.pageStack = [page("momentsList")];
elements.get("content-area").scrollTop = 640;
pushPage("personaDetail", { personaId: "cat" });
assert.equal(state.pageStack.at(-1).scrollTop, 640);
elements.get("content-area").scrollTop = 0;
goBack();
assert.equal(elements.get("content-area").scrollTop, 0, "渲染完成前不应过早恢复");
finishMomentsRender();
await Promise.resolve();
await Promise.resolve();
assert.equal(elements.get("content-area").scrollTop, 640, "返回后应恢复朋友圈原位置");

console.log("navigation return-state tests passed");