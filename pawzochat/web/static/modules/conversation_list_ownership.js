export function ownsConversationListTarget({
  target,
  desktop,
  currentDesktop,
  currentTab,
  pageDepth,
  contentTarget,
  sidebarTarget,
}) {
  if (!target || desktop !== currentDesktop) return false;
  if (desktop) return target.isConnected && currentTab === "chat" && target === sidebarTarget;
  if (target.dataset?.tabPanel) return target.dataset.tabPanel === "chat";
  if (pageDepth !== 0) return false;
  return target.isConnected && currentTab === "chat" && target === contentTarget;
}