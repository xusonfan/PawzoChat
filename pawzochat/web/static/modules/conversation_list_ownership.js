export function ownsConversationListTarget({
  target,
  desktop,
  currentDesktop,
  currentTab,
  pageDepth,
  contentTarget,
  sidebarTarget,
}) {
  if (!target || !target.isConnected || currentTab !== "chat") return false;
  if (desktop !== currentDesktop) return false;
  if (desktop) return target === sidebarTarget;
  return pageDepth === 0 && target === contentTarget;
}