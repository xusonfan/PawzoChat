/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/* PawzoChat SPA — Module entry point */

import { avatarHtml, esc, escAttr, iconHtml } from "./modules/utils.js";
import { api } from "./modules/api.js";
import {
  getMomentsUnreadAuthors,
  initMomentsUnread,
  markMomentsRead,
  subscribeMomentsUnread,
} from "./modules/moments_unread.js";
import { state, content, sidebar } from "./modules/state.js";
import { closeOverlay, closeConfirm, step, toast, showSheet, showLoading, hideLoading } from "./modules/ui.js";
import {
  showErrorBanner, toggleErrorBanner, closeErrorBanner,
} from "./modules/error_banner.js";
import { choicePickerSelect } from "./modules/choice_picker.js";
import { openImagePreview, closeImagePreview } from "./modules/image_preview.js";
import { rememberImageLayout } from "./modules/image_layout_cache.js";
import { errorNoticeFromEvent } from "./modules/error_feedback.js";
import {
  setTopBar, switchTab, goBack, pushPage, navigateToPage,
  registerTabRenderer, registerPageRenderer,
  isDesktop, setSidebarBar, initMobileTabSwipe,
} from "./modules/navigation.js";
import { applyThemeFromState, watchSystemTheme } from "./modules/theme.js";
import {
  cachedNotificationIcon,
  notifyNewMessage,
  rememberHandledMessageKeys,
} from "./modules/notification_feedback.js";
import {
  clearLocalCache, getLocalStorageSummary, initOfflineMode,
  initPwa, requestPwaInstall,
} from "./modules/pwa.js";
import { deleteSharedPayload, readSharedPayload } from "./modules/share_target_store.js";
import {
  detectSharedImport, importDetectedSharedFile,
} from "./modules/shared_import.js";
import {
  syncWebPushSubscription,
  systemNotificationsEnabled,
} from "./modules/push_notifications.js";

import {
  chatPersonaId, renderChatList, refreshChatMessages, refreshUnreadCounts,
  applyAssistantUnread, isViewingChat, markConversationRead,
  filterConvs, newConversation, startChat, openChat,
  chooseSharedContent, startSharedChat,
  chatMore, pickChatBackground, onChatBackgroundSelected, removeChatBackground,
  clearChat, deleteChat,
  linkWechat, doLinkWechat, unlinkWechat, viewPersonaFromChat, viewMemoryFromChat,
  openHistoryEdit,
  onChatInput, onChatKey, onChatCompositionStart, onChatCompositionEnd, sendChat,
  retryOutboxMessages,
  toggleVoiceInputMode, startVoiceRecording, moveVoiceRecording, finishVoiceRecording, cancelVoiceRecording,
  takePhoto, capturePhoto, switchCameraFacing, toggleCameraTorch, setCameraZoom,
  startCameraGesture, moveCameraGesture, endCameraGesture,
  pickImage, onImageSelected, removePendingImage,
  pickFile, onFileSelected, removePendingFile,
  showTypingIndicator, appendAssistantMessage, updateAssistantMessage,
  handleChatOperationError,
  toggleEmojiPicker, switchEmojiTab, insertEmoji, sendSticker,
  togglePlusMenu, openLocationShare, selectLocationOnMap, zoomLocationMap,
  searchLocationPlaces, chooseLocationPlace, sendSelectedLocation,
  quoteMessage, clearPendingQuote, regenerateChatReply,
  playVoiceMessage, toggleVoiceTranscript, retryGeneratedImage, retryChatReply,
  scrollToLatestMessage,
} from "./modules/chat.js";

import {
  heDateChange,
  editHistoryMsg, saveHistoryMsg, cancelHistoryEdit, deleteHistoryMsg,
  heClearQuoteEdit,
  heEnterSelectMode, heExitSelectMode, heToggleSelectItem,
  heToggleSelectAllCurrentDate, heBatchDeleteSelected,
} from "./modules/history_edit.js";

import {
  filterPersonas, chatWithPersona, deletePersona, savePersona,
  switchPersonaEditTab, resetSystemInstructions, onPersonaProviderChange,
  onPersonaImageProviderChange,
  onAvatarFileSelected, openCropModal, closeCropModal, confirmCrop,
  peWorldbookAdd,
  personaImportPick, personaImportSubmit,
  personaExportPick, _personaExportGo,
  _personaExportCoverSelected, _personaExportCoverReset, _personaExportPngGo,
  onPeImgRefModeChange, onPeImgRefFileSelected, deletePersonaRefImage,
  onPeMemTriggerModeChange,
  onPersonaVoiceProviderChange, onPersonaVoiceModelChange,
} from "./modules/contacts.js";

import {
  contactsIndexEnd,
  contactsIndexMove,
  contactsIndexStart,
  jumpToContactInitial,
} from "./modules/contacts_index.js";

import {
  addAccount, openAccount, deleteAccount, saveAccountNote,
  skipAccountNote, confirmAccountNote,
  selectChannelType, submitFormAccount,
  saveProvider, deleteProvider,
  importPresetModels, addEditModel, confirmAddModel, removeEditModel,
  fetchRemoteModels, confirmFetchModels, toggleFetchSelectAll, confirmModelSelection,
  editModel, confirmEditModel,
  onProviderPresetChange, onProviderTypeChange, updateProviderPreview,
  openProviderTypeSheet,
  saveImageProvider, deleteImageProvider,
  onImageProviderPresetChange, updateImageProviderPreview,
  importImagePresetModels,
  openImageProviderTypeSheet,
  addEditImageModel, confirmAddImageModel,
  editImageModel, confirmEditImageModel, removeEditImageModel,
  openImageTest, onImageTestProviderChange, onImageTestModelChange, onImageTestPromptInput, onImageTestPersonaChange, runImageTest,
  openVoiceProviderTypeSheet,
  saveVoiceProvider, deleteVoiceProvider, saveAsrSettings,
  onVoiceProviderPresetChange, updateVoiceProviderPreview,
  importVoicePresetModels,
  addEditVoiceModel, confirmAddVoiceModel,
  editVoiceModel, confirmEditVoiceModel, removeEditVoiceModel,
  openVoiceTest, onVoiceTestProviderChange, onVoiceTestModelChange, onVoiceTestVoiceChange, onVoiceTestTextInput, runVoiceTest,
  onTypingDelayToggle,
  previewNewMessageSound, enableSystemNotifications,
  confirmClearLocalCache,
  saveSettingsChat, saveSettingsReply,
  onThemeModeChange, onThemeToggle, onThemeMove, onThemeDelete, saveSettingsTheme,
  themeImportPick, themeImportSubmit,
  themeSelectionEnter, themeSelectionExit, themeSelectionToggle, themeSelectionToggleAll,
  themeExportSelected,
  savePassword, clearPassword, saveAdminPassword, clearAdminPassword, togglePublicAccess,
  cancelPublicToggle, confirmPublicToggle,
  regeneratePublicAccess, copyPublicUrl, copyPublicField,
  emojiAddGroup, emojiConfirmAddGroup,
  emojiAddEmotion, emojiConfirmAddEmotion,
  emojiRenameGroup, emojiConfirmRenameGroup, emojiDeleteGroup,
  emojiRenameEmotion, emojiConfirmRenameEmotion, emojiDeleteEmotion,
  emojiUploadImages, emojiImageMenu,
  emojiRenameImage, emojiConfirmRenameImage, emojiDeleteImage,
  emojiImportPick, emojiImportSubmit, emojiExportGroup,
  onProfileAvatarSelected, saveProfile,
  checkForUpdate, startUpdateDownload, onUpdateProgress, applyUpdate,
  toggleTelemetry,
} from "./modules/settings.js";

import {
  addMemory, editMemory, saveMemory, deleteMemoryConfirm,
} from "./modules/memory.js";

import {
  mcpTransportChange,
  mcpAddEnvRow, mcpRemoveEnvRow, mcpUpdateEnvKey, mcpUpdateEnvVal,
  mcpTestConnection,
  mcpSaveServer, mcpDeleteServer,
  mcpConnect, mcpDisconnect, mcpRefresh,
  mcpToggleAdapterAdvanced, mcpAdapterServerChange,
  mcpAddAdapterParam, mcpRemoveAdpParam, mcpUpdateAdpParam,
  mcpAddAdapterMapping, mcpRemoveAdpMapping, mcpUpdateAdpMapping,
  mcpAddAdapterInject, mcpRemoveAdpInject, mcpUpdateAdpInject,
  mcpSaveAdapter, mcpDeleteAdapter,
  mcpSwitchEditMode, mcpParseJson, mcpImportJson,
  mcpSaveUrl, mcpUrlAutoName,
} from "./modules/mcp.js";

import {
  pluginToggle, pluginSaveConfig, pluginReload, pluginRefresh,
} from "./modules/plugins.js";

import {
  showQuickSetup, submitQuickSetup, skipQuickSetup,
  checkAndShowSetup,
  qsProviderChange, qsAvatarSelected,
  qsSelectAccount, qsStartScan,
  qsChannelChange, qsSubmitForm,
  qsImportProviderChange,
  qsSetCreateMode, qsImportFilePicked, qsImportWbToggle,
  qsPasteApiKey, qsGeneratePersona, qsClearNameError,
  qsToggleCollapse, qsToggleStep4Telemetry,
  finishQuickSetup,
} from "./modules/quick_setup.js";

import {
  wbImportPick, wbImportSubmit,
  wbSave, wbDeleteCurrent,
  wbAddSection, wbRemoveSection,
  wbSectionKeyChange, wbSectionValChange, wbSectionToggle,
  wbPickerConfirm,
  wbOnRangeChange, wbOnKwToggle, wbPersonaPick, wbPersonaPickConfirm,
  wbExportPick, wbExportCurrent, _wbExportGo,
} from "./modules/worldbook.js";

import {
  momentsRefresh, momentsOpenPublish, momentsOpenAuthor, momentsItemMenu, momentsDelete,
  momentsLikeToggle, momentsOpenComposer, momentsReplyTo,
  momentsReplyMenu, momentsDeleteReply,
  momentsCloseComposer, momentsSubmitReply,
  momentsEdit, momentsEditReply, momentsSubmitEdit,
  momentsPickCover, momentsCoverMenu, momentsPickCoverFile,
  momentsOnCoverFile, momentsCoverDelete,
  momentsPickPubImages, momentsOnPublishFiles, momentsRemovePubImage,
  momentsSubmitPublish,
  momentsResetPrompt, momentsSaveSettings,
  momentsOnUpdate, momentsOnGenerating,
  openPersonaMoments, momentsOpenDetail,
} from "./modules/moments.js";

import {
  pwOnProviderChange, pwOnImageProviderChange, pwSwitchTab,
  pwGenerate, pwGenerateImage, pwCreatePersona,
} from "./modules/persona_writer.js";

import {
  imageGalleryProviderChange, imageGalleryModelChange,
  imageGalleryPickReference, imageGalleryReferenceSelected, imageGalleryClearReference,
  imageGalleryGenerate, imageGalleryOpen, imageGalleryReusePrompt,
  imageGalleryDelete, imageGalleryEnterSelection, imageGalleryExitSelection,
  imageGalleryToggleAll, imageGalleryDeleteSelected,
} from "./modules/image_gallery.js";

import {
  radarOpenProviderPicker, radarOpenModelPicker, radarOpenPersonaTypePicker,
  radarSetPersonaType, radarRefresh, radarUseRecommendation,
} from "./modules/radar.js";

import {
  stickerMakerOpenProviderPicker, stickerMakerOpenModelPicker,
  stickerMakerPickReference, stickerMakerReferenceSelected,
  stickerMakerGenerate, stickerMakerSave,
} from "./modules/sticker_maker.js";

/* ============ Discover Tab ============ */

function momentsUnreadAvatarsHtml() {
  const authors = getMomentsUnreadAuthors();
  if (!authors.length) return "";
  const labels = authors.map(item => item.authorLabel).join("、");
  const avatars = authors.map(item => {
    const avatarUrl = `${window.PAWZOCHAT_BASE || ""}/api/personas/${encodeURIComponent(item.author)}/avatar`;
    return avatarHtml(item.authorLabel, "", avatarUrl);
  }).join("");
  return `<span class="moments-unread-avatars" role="status" aria-label="${escAttr(labels)} 发布了新朋友圈">${avatars}</span>`;
}

function syncMomentsUnreadIndicators() {
  const html = momentsUnreadAvatarsHtml();
  const hasUnread = getMomentsUnreadAuthors().length > 0;
  document.querySelectorAll("[data-moments-unread]").forEach(host => {
    host.innerHTML = html;
  });
  document.querySelectorAll("#tab-bar .tab[data-tab='discover']").forEach(tab => {
    const dot = tab.querySelector(".moments-tab-unread-dot");
    if (!hasUnread) {
      dot?.remove();
      tab.removeAttribute("aria-label");
      return;
    }
    tab.setAttribute("aria-label", "发现，有新朋友圈");
    if (dot) return;
    const nextDot = document.createElement("span");
    nextDot.className = "moments-tab-unread-dot";
    nextDot.setAttribute("aria-hidden", "true");
    tab.appendChild(nextDot);
  });
}

subscribeMomentsUnread(syncMomentsUnreadIndicators);

function openMomentsFromDiscover() {
  // Clear while the discover panel is still mounted; navigation caches the
  // panel after this handler returns, so the cached copy must already be clean.
  markMomentsRead();
  pushPage("momentsList", {});
}

function renderDiscover() {
  const desktop = isDesktop();
  const target = desktop ? sidebar() : content();

  if (desktop) setSidebarBar("发现", "");
  else setTopBar("发现", false, "");

  target.innerHTML = `<div class="page">
    <div class="card">
      <div class="card-row" onclick="PawzoChat.openMomentsFromDiscover()">
        <div class="row-icon peach">${iconHtml("ri-camera-fill")}</div>
        <span class="row-label">朋友圈</span>
        <span class="moments-unread-host" data-moments-unread>${momentsUnreadAvatarsHtml()}</span>
        <span class="row-arrow">›</span>
      </div>
      <div class="card-row" onclick="PawzoChat.pushPage('stickerMaker',{})">
        <div class="row-icon yellow">${iconHtml("ri-chat-smile-2-line")}</div>
        <span class="row-label">表情包工坊</span><span class="row-arrow">›</span>
      </div>
      <div class="card-row" onclick="PawzoChat.pushPage('worldbookList',{})">
        <div class="row-icon blue">${iconHtml("ri-book-open-line")}</div>
        <span class="row-label">世界书</span><span class="row-arrow">›</span>
      </div>
      <div class="card-row" onclick="PawzoChat.pushPage('radar',{})">
        <div class="row-icon cyan">${iconHtml("ri-radar-line")}</div>
        <span class="row-label">雷达</span><span class="row-arrow">›</span>
      </div>
      <div class="card-row" onclick="PawzoChat.pushPage('personaWriter',{})">
        <div class="row-icon purple">${iconHtml("ri-quill-pen-line")}</div>
        <span class="row-label">人设编写助手</span><span class="row-arrow">›</span>
      </div>
      <div class="card-row" onclick="PawzoChat.pushPage('imageGallery',{})">
        <div class="row-icon indigo">${iconHtml("ri-image-add-line")}</div>
        <span class="row-label">AI 图库</span><span class="row-arrow">›</span>
      </div>
    </div>
  </div>`;
}

function renderPlaceholder(data) {
  setTopBar(data.name, true, "");
  document.getElementById("content-area").innerHTML = `<div class="placeholder-page">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
    <div class="title">即将推出</div>
    <div class="desc">${esc(data.desc)}</div>
  </div>`;
}

registerTabRenderer("discover", renderDiscover);
registerPageRenderer("discoverPlaceholder", renderPlaceholder);

/* ============ SSE ============ */

function initSSE() {
  if (state.sseSource) state.sseSource.close();
  const source = new EventSource((window.PAWZOCHAT_BASE || "") + "/api/events");
  state.sseSource = source;
  state.sseConnected = false;
  source.onopen = () => {
    if (state.sseSource === source) state.sseConnected = true;
  };
  source.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      const errorNotice = errorNoticeFromEvent(data);
      if (data.type === "operation_error") {
        state.processingPersonas.delete(data.persona_id);
        if (isViewingChat(data.persona_id)) handleChatOperationError(data);
      } else if (
        errorNotice
        && (!data.persona_id || isViewingChat(data.persona_id))
      ) {
        showErrorBanner(errorNotice.message, errorNotice.title);
      }
      if (data.type === "processing") {
        state.processingPersonas.add(data.persona_id);
        if (data.persona_id === chatPersonaId) showTypingIndicator();
      }
      if (data.type === "assistant_message") {
        if (data.is_last) state.processingPersonas.delete(data.persona_id);
        const viewingChat = isViewingChat(data.persona_id);
        applyAssistantUnread(data.persona_id, data.unread_count);
        const persona = state.personas.find(item => item.id === data.persona_id);
        notifyNewMessage(data, {
          isViewing: viewingChat,
          systemNotificationsEnabled: systemNotificationsEnabled(),
          settings: state.settings?.chat,
          personaName: persona?.name || "PawzoChat",
          iconUrl: cachedNotificationIcon(data.persona_id),
          baseUrl: window.PAWZOCHAT_BASE || "",
        });
        if (viewingChat) {
          appendAssistantMessage(data.message, data.is_last);
          markConversationRead(data.persona_id, data.message?._seq);
        }
      }
      if (data.type === "assistant_message_updated") {
        api.invalidate(k => k.startsWith(`/api/conversations/${data.persona_id}/messages`));
        if (isViewingChat(data.persona_id)) {
          void updateAssistantMessage(data.message);
        }
      }
      if (data.type === "new_message") {
        api.invalidate(k => k.startsWith("/api/conversations"));
        if (data.persona_id === chatPersonaId) refreshChatMessages();
      }
      if (data.type === "conversation_updated") {
        api.invalidate(k => k.startsWith("/api/conversations"));
        // One path only: full list paint already applies unread atomically.
        // Running refreshUnreadCounts + renderChatList together caused
        // remove/rebuild badge flash and concurrent response races.
        if (state.currentTab === "chat" && (isDesktop() || state.pageStack.length === 0)) {
          renderChatList();
        } else {
          refreshUnreadCounts();
        }
        // This event only invalidates conversation metadata. Message bodies
        // have their own new_message / assistant_message events; refreshing
        // them here rebuilds the just-appended final reply multiple times.
      }
      if (data.type === "update_progress") {
        onUpdateProgress(data);
      }
      if (data.type === "moments_updated") {
        api.invalidate(k => k.startsWith("/api/moments"));
        momentsOnUpdate(data);
      }
      if (data.type === "moments_generating") {
        api.invalidate("/api/moments/state");
        momentsOnGenerating(data.is_generating);
      }
    } catch (err) { /* silent */ }
  };
  source.onerror = () => {
    if (state.sseSource === source) state.sseConnected = false;
    // EventSource handles retries itself and preserves Last-Event-ID. Replacing
    // it here would discard the cursor and make missed-event replay impossible.
  };
}

/* ============ Public API ============ */

window.PawzoChat = {
  switchTab, goBack, pushPage, openMomentsFromDiscover,
  requestPwaInstall, clearLocalCache, getLocalStorageSummary,
  closeOverlay, closeConfirm, choicePickerSelect,
  closeErrorBanner, toggleErrorBanner,
  openImagePreview, closeImagePreview, rememberImageLayout,
  newConversation, startChat, openChat, startSharedChat,
  filterConvs, chatMore, pickChatBackground, onChatBackgroundSelected, removeChatBackground,
  clearChat, deleteChat,
  linkWechat, doLinkWechat, unlinkWechat, viewPersonaFromChat, viewMemoryFromChat,
  openHistoryEdit,
  heDateChange,
  editHistoryMsg, saveHistoryMsg, cancelHistoryEdit, deleteHistoryMsg,
  heClearQuoteEdit,
  heEnterSelectMode, heExitSelectMode, heToggleSelectItem,
  heToggleSelectAllCurrentDate, heBatchDeleteSelected,
  onChatInput, onChatKey, onChatCompositionStart, onChatCompositionEnd, sendChat,
  retryOutboxMessages,
  toggleVoiceInputMode, startVoiceRecording, moveVoiceRecording, finishVoiceRecording, cancelVoiceRecording,
  takePhoto, capturePhoto, switchCameraFacing, toggleCameraTorch, setCameraZoom,
  startCameraGesture, moveCameraGesture, endCameraGesture,
  pickImage, onImageSelected, removePendingImage,
  pickFile, onFileSelected, removePendingFile,
  toggleEmojiPicker, switchEmojiTab, insertEmoji, sendSticker,
  togglePlusMenu, openLocationShare, selectLocationOnMap, zoomLocationMap,
  searchLocationPlaces, chooseLocationPlace, sendSelectedLocation,
  quoteMessage, clearPendingQuote, regenerateChatReply,
  playVoiceMessage, toggleVoiceTranscript, retryGeneratedImage, retryChatReply,
  scrollToLatestMessage,
  filterPersonas, contactsIndexStart, contactsIndexMove, contactsIndexEnd, jumpToContactInitial,
  chatWithPersona, deletePersona,
  savePersona, switchPersonaEditTab, resetSystemInstructions, onPersonaProviderChange,
  onPersonaImageProviderChange,
  onPersonaVoiceProviderChange, onPersonaVoiceModelChange,
  onAvatarFileSelected, openCropModal, closeCropModal, confirmCrop,
  peWorldbookAdd,
  personaImportPick, personaImportSubmit,
  personaExportPick, _personaExportGo,
  _personaExportCoverSelected, _personaExportCoverReset, _personaExportPngGo,
  onPeImgRefModeChange, onPeImgRefFileSelected, deletePersonaRefImage,
  addAccount, openAccount, deleteAccount, saveAccountNote, skipAccountNote, confirmAccountNote,
  selectChannelType, submitFormAccount,
  saveProvider, deleteProvider,
  importPresetModels, addEditModel, confirmAddModel, removeEditModel,
  fetchRemoteModels, confirmFetchModels, toggleFetchSelectAll, confirmModelSelection,
  editModel, confirmEditModel,
  onProviderPresetChange, onProviderTypeChange, updateProviderPreview,
  openProviderTypeSheet,
  saveImageProvider, deleteImageProvider,
  onImageProviderPresetChange, updateImageProviderPreview,
  importImagePresetModels,
  openImageProviderTypeSheet,
  addEditImageModel, confirmAddImageModel,
  editImageModel, confirmEditImageModel, removeEditImageModel,
  openImageTest, onImageTestProviderChange, onImageTestModelChange, onImageTestPromptInput, onImageTestPersonaChange, runImageTest,
  openVoiceProviderTypeSheet,
  saveVoiceProvider, deleteVoiceProvider, saveAsrSettings,
  onVoiceProviderPresetChange, updateVoiceProviderPreview,
  importVoicePresetModels,
  addEditVoiceModel, confirmAddVoiceModel,
  editVoiceModel, confirmEditVoiceModel, removeEditVoiceModel,
  openVoiceTest, onVoiceTestProviderChange, onVoiceTestModelChange, onVoiceTestVoiceChange, onVoiceTestTextInput, runVoiceTest,
  onTypingDelayToggle,
  previewNewMessageSound, enableSystemNotifications,
  confirmClearLocalCache,
  saveSettingsChat, saveSettingsReply,
  onThemeModeChange, onThemeToggle, onThemeMove, onThemeDelete, saveSettingsTheme,
  themeImportPick, themeImportSubmit,
  themeSelectionEnter, themeSelectionExit, themeSelectionToggle, themeSelectionToggleAll,
  themeExportSelected,
  savePassword, clearPassword, saveAdminPassword, clearAdminPassword, togglePublicAccess,
  cancelPublicToggle, confirmPublicToggle,
  regeneratePublicAccess, copyPublicUrl, copyPublicField,
  emojiAddGroup, emojiConfirmAddGroup,
  emojiAddEmotion, emojiConfirmAddEmotion,
  emojiRenameGroup, emojiConfirmRenameGroup, emojiDeleteGroup,
  emojiRenameEmotion, emojiConfirmRenameEmotion, emojiDeleteEmotion,
  emojiUploadImages, emojiImageMenu,
  emojiRenameImage, emojiConfirmRenameImage, emojiDeleteImage,
  emojiImportPick, emojiImportSubmit, emojiExportGroup,
  onProfileAvatarSelected, saveProfile,
  addMemory, editMemory, saveMemory, deleteMemoryConfirm,
  step,
  mcpTransportChange,
  mcpAddEnvRow, mcpRemoveEnvRow, mcpUpdateEnvKey, mcpUpdateEnvVal,
  mcpTestConnection,
  mcpSaveServer, mcpDeleteServer,
  mcpConnect, mcpDisconnect, mcpRefresh,
  mcpToggleAdapterAdvanced, mcpAdapterServerChange,
  mcpAddAdapterParam, mcpRemoveAdpParam, mcpUpdateAdpParam,
  mcpAddAdapterMapping, mcpRemoveAdpMapping, mcpUpdateAdpMapping,
  mcpAddAdapterInject, mcpRemoveAdpInject, mcpUpdateAdpInject,
  mcpSaveAdapter, mcpDeleteAdapter,
  mcpSwitchEditMode, mcpParseJson, mcpImportJson,
  mcpSaveUrl, mcpUrlAutoName,
  pluginToggle, pluginSaveConfig, pluginReload, pluginRefresh,
  showQuickSetup, submitQuickSetup, skipQuickSetup,
  qsProviderChange, qsAvatarSelected,
  qsSelectAccount, qsStartScan,
  qsChannelChange, qsSubmitForm,
  qsImportProviderChange,
  qsSetCreateMode, qsImportFilePicked, qsImportWbToggle,
  qsPasteApiKey, qsGeneratePersona, qsClearNameError,
  qsToggleCollapse, qsToggleStep4Telemetry,
  finishQuickSetup,
  checkForUpdate, startUpdateDownload, applyUpdate,
  toggleTelemetry,
  wbImportPick, wbImportSubmit,
  wbSave, wbDeleteCurrent,
  wbAddSection, wbRemoveSection,
  wbSectionKeyChange, wbSectionValChange, wbSectionToggle,
  wbPickerConfirm,
  wbOnRangeChange, wbOnKwToggle, wbPersonaPick, wbPersonaPickConfirm,
  wbExportPick, wbExportCurrent, _wbExportGo,
  momentsRefresh, momentsOpenPublish, momentsOpenAuthor, momentsItemMenu, momentsDelete,
  momentsLikeToggle, momentsOpenComposer, momentsReplyTo,
  momentsReplyMenu, momentsDeleteReply,
  momentsCloseComposer, momentsSubmitReply,
  momentsEdit, momentsEditReply, momentsSubmitEdit,
  momentsPickCover, momentsCoverMenu, momentsPickCoverFile,
  momentsOnCoverFile, momentsCoverDelete,
  momentsPickPubImages, momentsOnPublishFiles, momentsRemovePubImage,
  momentsSubmitPublish,
  momentsResetPrompt, momentsSaveSettings,
  openPersonaMoments, momentsOpenDetail,
  pwOnProviderChange, pwOnImageProviderChange, pwSwitchTab,
  pwGenerate, pwGenerateImage, pwCreatePersona,
  imageGalleryProviderChange, imageGalleryModelChange,
  imageGalleryPickReference, imageGalleryReferenceSelected, imageGalleryClearReference,
  imageGalleryGenerate, imageGalleryOpen, imageGalleryReusePrompt,
  imageGalleryDelete, imageGalleryEnterSelection, imageGalleryExitSelection,
  imageGalleryToggleAll, imageGalleryDeleteSelected,
  radarOpenProviderPicker, radarOpenModelPicker, radarOpenPersonaTypePicker,
  radarSetPersonaType, radarRefresh, radarUseRecommendation,
  stickerMakerOpenProviderPicker, stickerMakerOpenModelPicker,
  stickerMakerPickReference, stickerMakerReferenceSelected,
  stickerMakerGenerate, stickerMakerSave,
};

/* ============ Init ============ */

async function loadProfile() {
  try {
    const res = await api.get("/api/profile");
    state.profile = {
      name: res.name || "我",
      has_avatar: !!res.has_avatar,
      avatar_version: res.avatar_version || "",
    };
  } catch (e) { /* keep default */ }
}

async function loadThemeSettings() {
  try {
    const [settings, asr] = await Promise.all([
      api.get("/api/settings"),
      api.get("/api/asr/settings"),
    ]);
    state.settings = { ...settings, asr };
  } catch (e) { /* keep default */ }
  try { await applyThemeFromState(); } catch (e) { /* silent */ }
  watchSystemTheme();
}

async function checkUpdateOnStartup() {
  const maxRetries = 15;
  const retryDelay = 2000;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const u = await api.get("/api/update/check");
      if (u.checking) {
        await new Promise(r => setTimeout(r, retryDelay));
        continue;
      }
      state._updateInfo = u;
      if (u.download_state) state._updateState = u.download_state;
      if (u.has_update && u.latest_version) {
        await _waitOverlayClear();
        _showUpdateFoundDialog(u);
      }
      return;
    } catch (e) {
      return;
    }
  }
}

function _waitOverlayClear(maxWait = 120000) {
  return new Promise(resolve => {
    const overlay = document.getElementById("overlay");
    if (!overlay || !overlay.classList.contains("show")) {
      resolve();
      return;
    }
    const start = Date.now();
    const poll = () => {
      if (Date.now() - start > maxWait || !overlay.classList.contains("show")) {
        resolve();
        return;
      }
      setTimeout(poll, 500);
    };
    poll();
  });
}

function _showUpdateFoundDialog(u) {
  const latest = esc(u.latest_version || "");
  const current = esc(u.current_version || "");
  const changelog = (u.changelog || "").trim();
  const updateState = u.download_state || state._updateState || {};
  const canDownload = !!u.download_available;
  const ready = !!updateState.ready;

  let changelogHtml = "";
  if (changelog) {
    const lines = changelog.split("\n").slice(0, 15).join("\n");
    changelogHtml = `<div style="margin:12px 0 0;max-height:200px;overflow-y:auto;padding:10px 12px;background:var(--bg);border-radius:8px;font-size:13px;color:var(--text-2);white-space:pre-wrap;line-height:1.6;text-align:left">${esc(lines)}</div>`;
  }

  const actionBtn = ready
    ? `<button onclick="PawzoChat.applyUpdate()" style="flex:1;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--primary);color:#fff;font-size:15px;cursor:pointer;font-family:var(--font)">立即重启更新</button>`
    : canDownload
      ? `<button onclick="PawzoChat.startUpdateDownload()" style="flex:1;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--primary);color:#fff;font-size:15px;cursor:pointer;font-family:var(--font)">下载并更新</button>`
      : `<button onclick="PawzoChat.closeOverlay();PawzoChat.switchTab('settings');setTimeout(()=>PawzoChat.pushPage('settingsAbout'),300)" style="flex:1;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--primary);color:#fff;font-size:15px;cursor:pointer;font-family:var(--font)">查看详情</button>`;

  showSheet(`<div style="padding:24px">
    <div style="text-align:center;margin-bottom:8px">
      <div style="width:48px;height:48px;border-radius:50%;background:var(--primary-light);color:var(--primary);display:inline-flex;align-items:center;justify-content:center;font-size:24px">
        ${iconHtml("ri-upload-2-line")}
      </div>
    </div>
    <div class="sheet-title">发现新版本</div>
    <div style="text-align:center;margin:8px 0 4px;font-size:14px;color:var(--text-2)">
      <span>v${current}</span>
      <span style="margin:0 8px;color:var(--text-3)">→</span>
      <span style="color:var(--primary);font-weight:600">v${latest}</span>
    </div>
    ${changelogHtml}
    <div style="display:flex;gap:12px;margin-top:20px">
      <button onclick="PawzoChat.closeOverlay()" style="flex:1;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--bg);color:var(--text-2);font-size:15px;cursor:pointer;font-family:var(--font)">稍后再说</button>
      ${actionBtn}
    </div>
  </div>`);
}

async function clearNotificationsForPersona(personaId) {
  if (!personaId || !("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const workers = new Set([
      registration.active,
      navigator.serviceWorker.controller,
    ].filter(Boolean));
    for (const worker of workers) {
      worker.postMessage({ type: "clear_persona_notifications", personaId });
    }
  } catch (_) {
    // Notification cleanup must not block opening the conversation.
  }
}

function openConversationFromNotification(personaId) {
  if (!personaId) return;
  void clearNotificationsForPersona(personaId);
  switchTab("chat");
  void openChat(personaId);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", event => {
    rememberHandledMessageKeys(event.data?.handledMessageKeys || []);
    if (event.data?.type === "open_conversation") {
      openConversationFromNotification(event.data.personaId);
    }
  });
}

function syncFocusedChatReadState() {
  if (!isViewingChat()) return;
  markConversationRead();
  refreshChatMessages();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!state.sseSource || state.sseSource.readyState === EventSource.CLOSED) initSSE();
  syncFocusedChatReadState();
});

window.addEventListener("focus", syncFocusedChatReadState);

window.addEventListener("online", () => {
  if (!state.sseSource || state.sseSource.readyState === EventSource.CLOSED) initSSE();
});

function formatSharedFileSize(bytes) {
  const size = Math.max(0, Number(bytes) || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function confirmSharedImport(detected) {
  return new Promise(resolve => {
    const isPersona = detected.kind === "persona";
    const typeLabel = isPersona ? "角色卡" : "世界书";
    const previewUrl = isPersona && detected.preview === "image"
      ? URL.createObjectURL(detected.file)
      : "";
    const preview = previewUrl
      ? `<img class="shared-import-avatar-image" src="${escAttr(previewUrl)}" alt="${escAttr(detected.name)}">`
      : isPersona
        ? avatarHtml(detected.name, "lg", "")
        : `<div class="shared-import-book-icon">${iconHtml("ri-book-open-line")}</div>`;
    let accepted = false;

    showSheet(`
      <div class="shared-import-confirm" role="dialog" aria-labelledby="shared-import-title">
        <div class="shared-import-preview">${preview}</div>
        <div class="shared-import-type">检测到${typeLabel}</div>
        <div class="shared-import-name" id="shared-import-title">${esc(detected.name)}</div>
        <div class="shared-import-file">${esc(detected.file.name || "未命名文件")} · ${formatSharedFileSize(detected.file.size)}</div>
        <div class="shared-import-question">是否导入到 PawzoChat？</div>
        <div class="shared-import-actions">
          <button type="button" class="shared-import-cancel" id="shared-import-cancel">取消</button>
          <button type="button" class="shared-import-submit" id="shared-import-submit">导入</button>
        </div>
      </div>`,
    () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      resolve(accepted);
    }, { className: "shared-import-sheet" });

    document.getElementById("shared-import-cancel")?.addEventListener("click", () => {
      void closeOverlay();
    });
    document.getElementById("shared-import-submit")?.addEventListener("click", () => {
      accepted = true;
      void closeOverlay();
    });
  });
}

async function handleShareTarget(id) {
  try {
    const payload = await readSharedPayload(id);
    if (!payload) {
      toast("分享内容已失效，请重新分享", "error");
      return;
    }

    showLoading("正在识别分享内容…");
    let detectedImport;
    try {
      detectedImport = await detectSharedImport(payload);
    } finally {
      hideLoading();
    }
    if (detectedImport) {
      const typeLabel = detectedImport.kind === "persona" ? "角色" : "世界书";
      const accepted = await confirmSharedImport(detectedImport);
      if (!accepted) {
        await deleteSharedPayload(id);
        return;
      }

      showLoading(`正在导入${typeLabel}…`);
      let importResult;
      try {
        importResult = await importDetectedSharedFile(
          detectedImport,
          window.PAWZOCHAT_BASE || "",
        );
      } finally {
        hideLoading();
      }
      await deleteSharedPayload(id);
      if (!importResult.imported) {
        toast(importResult.error || "导入失败", "error");
        return;
      }
      if (importResult.kind === "persona") {
        api.invalidate(key => key.startsWith("/api/personas"));
        switchTab("contacts");
        const name = importResult.data?.name || "角色";
        const bookCount = importResult.data?.created_worldbooks?.length || 0;
        toast(bookCount > 0 ? `已导入「${name}」及 ${bookCount} 本世界书` : `已导入角色「${name}」`, "success");
      } else {
        api.invalidate(key => key.startsWith("/api/worldbooks"));
        switchTab("discover");
        pushPage("worldbookList", {});
        toast(`已导入世界书「${importResult.data?.book?.name || "未命名"}」`, "success");
      }
      return;
    }
    await chooseSharedContent(payload);
    await deleteSharedPayload(id);
  } catch (error) {
    await deleteSharedPayload(id).catch(() => undefined);
    console.warn("读取系统分享内容失败", error);
    toast("无法读取分享内容，请重新分享", "error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const launchUrl = new URL(window.location.href);
  const shortcutTargets = {
    radar: { tab: "discover", page: "radar" },
    "persona-writer": { tab: "discover", page: "personaWriter" },
    moments: { tab: "discover", page: "momentsList" },
    gallery: { tab: "discover", page: "imageGallery" },
  };
  const shortcutName = launchUrl.searchParams.get("shortcut");
  const shortcutTarget = shortcutTargets[shortcutName];
  const notificationPersonaId = launchUrl.searchParams.get("openChat");
  const shareTargetId = launchUrl.searchParams.get("shareTarget");
  const shareTargetError = launchUrl.searchParams.get("shareError") === "1";
  const handledMessageKeys = launchUrl.searchParams.getAll("handledMessageKey");
  rememberHandledMessageKeys(handledMessageKeys);
  if (shortcutTarget || notificationPersonaId || handledMessageKeys.length > 0 || shareTargetId || shareTargetError) {
    launchUrl.searchParams.delete("shortcut");
    launchUrl.searchParams.delete("openChat");
    launchUrl.searchParams.delete("handledMessageKey");
    launchUrl.searchParams.delete("shareTarget");
    launchUrl.searchParams.delete("shareError");
    history.replaceState(history.state, "", launchUrl.pathname + launchUrl.search + launchUrl.hash);
  }

  loadProfile();
  loadThemeSettings();
  initOfflineMode();
  void initPwa().then(() => syncWebPushSubscription());
  initMobileTabSwipe();
  void initMomentsUnread(api);
  switchTab("chat");
  if (notificationPersonaId) {
    setTimeout(() => openConversationFromNotification(notificationPersonaId), 0);
  } else if (shareTargetId) {
    setTimeout(() => { void handleShareTarget(shareTargetId); }, 0);
  } else if (shareTargetError) {
    setTimeout(() => toast("系统分享内容接收失败，请重新分享", "error"), 0);
  } else if (shortcutTarget?.page) {
    setTimeout(() => navigateToPage(shortcutTarget.tab, shortcutTarget.page, {}), 0);
  }
  initSSE();
  checkAndShowSetup();
  checkUpdateOnStartup();
});
