'use strict';

const DEFAULT_STATE = Object.freeze({
  playbackRate: 0.8,
  reverbWetMix: 0.4,
  lowBandDecibels: 0,
  preservesPitch: false,
});

const stateByTabId = new Map();
const captureStatusByTabId = new Map();
const contentPortsByTabId = new Map();
const popupPorts = new Map();

function getState(tabId) {
  if (!stateByTabId.has(tabId)) {
    stateByTabId.set(tabId, { ...DEFAULT_STATE });
  }
  return stateByTabId.get(tabId);
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (error) {
    // Injection can fail on restricted pages; ignore.
  }
}

function sendStateToContent(tabId) {
  const port = contentPortsByTabId.get(tabId);
  if (!port) {
    return;
  }
  try {
    port.postMessage({
      type: 'CONTENT_STATE_UPDATE',
      tabId,
      state: getState(tabId),
    });
  } catch (error) {
    // Port might be stale; ignore.
  }
}

function sendPopupState(port, tabId) {
  const captureStatus = captureStatusByTabId.get(tabId) || 'UNKNOWN';
  try {
    port.postMessage({
      type: 'POPUP_STATE',
      tabId,
      state: getState(tabId),
      captureStatus,
    });
  } catch (error) {
    // Ignore failed popup sends.
  }
}

function notifyPopupsForTab(tabId) {
  for (const [popupPort, popupTabId] of popupPorts.entries()) {
    if (popupTabId === tabId) {
      sendPopupState(popupPort, tabId);
    }
  }
}

async function broadcastToYouTubeTabs(stateUpdate) {
  const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
  for (const tab of tabs) {
    if (!tab.id) {
      continue;
    }
    const nextState = { ...getState(tab.id), ...stateUpdate };
    stateByTabId.set(tab.id, nextState);
    await ensureContentScript(tab.id);
    sendStateToContent(tab.id);
  }
}

function handlePopupPort(port) {
  port.onMessage.addListener(async (message) => {
    if (message?.type === 'POPUP_CONNECT' && message.tabId) {
      popupPorts.set(port, message.tabId);
      sendPopupState(port, message.tabId);
      await ensureContentScript(message.tabId);
      sendStateToContent(message.tabId);
      return;
    }

    if (message?.type === 'POPUP_UPDATE' && message.tabId && message.state) {
      const nextState = { ...getState(message.tabId), ...message.state };
      stateByTabId.set(message.tabId, nextState);
      sendStateToContent(message.tabId);
    }
  });

  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
  });
}

function handleContentPort(port) {
  const tabId = port.sender?.tab?.id;
  if (!tabId) {
    port.disconnect();
    return;
  }

  contentPortsByTabId.set(tabId, port);

  port.onDisconnect.addListener(() => {
    contentPortsByTabId.delete(tabId);
  });

  sendStateToContent(tabId);

  port.onMessage.addListener((message) => {
    if (!message?.type) {
      return;
    }

    if (message.type === 'CONTENT_CONNECT') {
      if (message.captureStatus) {
        captureStatusByTabId.set(tabId, message.captureStatus);
        notifyPopupsForTab(tabId);
      }
      return;
    }

    if (message.type === 'CONTENT_CAPTURE_STATUS') {
      captureStatusByTabId.set(tabId, message.captureStatus);
      notifyPopupsForTab(tabId);
    }
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    handlePopupPort(port);
    return;
  }

  if (port.name === 'content') {
    handleContentPort(port);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stateByTabId.delete(tabId);
  captureStatusByTabId.delete(tabId);
  contentPortsByTabId.delete(tabId);
});

// Expose broadcast helper for manual testing in the service worker console.
self.broadcastToYouTubeTabs = broadcastToYouTubeTabs;
