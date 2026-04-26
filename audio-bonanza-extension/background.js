'use strict';

const SERVER_URL = 'http://localhost:5055';
const DEFAULT_BROADCAST_URLS = ['*://*.youtube.com/*'];

const DEFAULT_STATE = Object.freeze({
  playbackRate: 0.8,
  reverbWetMix: 0.4,
  lowBandDecibels: 0,
  preservesPitch: false,
});

const stateByTabId = new Map();
const captureStatusByTabId = new Map();
const popupPorts = new Map();
const pendingInjection = new Set();

const STORAGE_KEY = 'tabStates';

async function loadStoredState() {
  try {
    const data = await chrome.storage.session.get(STORAGE_KEY);
    const stored = data[STORAGE_KEY];
    if (stored && typeof stored === 'object') {
      for (const [tabIdStr, tabState] of Object.entries(stored)) {
        const tabId = parseInt(tabIdStr, 10);
        if (!isNaN(tabId)) {
          stateByTabId.set(tabId, sanitizeState(tabState, DEFAULT_STATE));
        }
      }
    }
  } catch (e) {
    console.warn('[AudioRemix] Failed to load stored state', e);
  }
}

function saveState() {
  const obj = {};
  for (const [tabId, tabState] of stateByTabId.entries()) {
    obj[String(tabId)] = tabState;
  }
  chrome.storage.session.set({ [STORAGE_KEY]: obj }).catch(() => {});
}

const storageReadyPromise = loadStoredState();

let tabsPushTimer = null;
let serverReconnectTimer = null;
let eventSource = null;

const CLAMP_LIMITS = Object.freeze({
  playbackRate: [0.5, 1.5],
  reverbWetMix: [0, 1],
  lowBandDecibels: [0, 10],
});

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sanitizeState(input, baseState) {
  const nextState = { ...baseState };

  if (typeof input.playbackRate === 'number' && Number.isFinite(input.playbackRate)) {
    nextState.playbackRate = clamp(input.playbackRate, ...CLAMP_LIMITS.playbackRate);
  }
  if (typeof input.reverbWetMix === 'number' && Number.isFinite(input.reverbWetMix)) {
    nextState.reverbWetMix = clamp(input.reverbWetMix, ...CLAMP_LIMITS.reverbWetMix);
  }
  if (typeof input.lowBandDecibels === 'number' && Number.isFinite(input.lowBandDecibels)) {
    nextState.lowBandDecibels = clamp(input.lowBandDecibels, ...CLAMP_LIMITS.lowBandDecibels);
  }
  if (typeof input.preservesPitch === 'boolean') {
    nextState.preservesPitch = input.preservesPitch;
  }

  return nextState;
}

function getState(tabId) {
  if (!stateByTabId.has(tabId)) {
    stateByTabId.set(tabId, { ...DEFAULT_STATE });
  }
  return stateByTabId.get(tabId);
}

async function injectContentScript(tabId) {
  if (pendingInjection.has(tabId)) {
    return false;
  }
  pendingInjection.add(tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
      world: 'MAIN',
    });
    return true;
  } catch (error) {
    console.warn('[AudioRemix] Injection failed for tab', tabId, error);
    return false;
  } finally {
    pendingInjection.delete(tabId);
  }
}

async function applyStateToTab(tabId, nextState) {
  const applied = await tryApplyState(tabId, nextState);
  if (applied) {
    return true;
  }
  console.info('[AudioRemix] applyState missing; injecting content script for tab', tabId);
  const injected = await injectContentScript(tabId);
  if (!injected) {
    console.warn('[AudioRemix] Unable to inject content script for tab', tabId);
    return false;
  }
  const appliedAfterInject = await tryApplyState(tabId, nextState);
  if (!appliedAfterInject) {
    console.warn('[AudioRemix] applyState still unavailable after inject for tab', tabId);
  }
  return appliedAfterInject;
}

async function applyStateToTabWithSetters(tabId, nextState) {
  const applied = await tryApplySetters(tabId, nextState);
  if (applied) {
    return true;
  }
  console.info('[AudioRemix] setters missing; injecting content script for tab', tabId);
  const injected = await injectContentScript(tabId);
  if (!injected) {
    console.warn('[AudioRemix] Unable to inject content script for tab', tabId);
    return false;
  }
  const appliedAfterInject = await tryApplySetters(tabId, nextState);
  if (!appliedAfterInject) {
    console.warn('[AudioRemix] setters still unavailable after inject for tab', tabId);
  }
  return appliedAfterInject;
}

async function tryApplyState(tabId, nextState) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (state) => {
        const store = window.__audioRemixStore;
        if (!store || typeof store.applyState !== 'function') {
          return { ok: false };
        }
        store.applyState(state);
        return { ok: true };
      },
      args: [nextState],
    });
    return Boolean(results?.[0]?.result?.ok);
  } catch (error) {
    return false;
  }
}

async function tryApplySetters(tabId, nextState) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (state) => {
        const store = window.__audioRemixStore;
        if (!store) {
          return { ok: false };
        }
        let applied = false;
        if (typeof store.setPlaybackRate === 'function' && typeof state.playbackRate === 'number') {
          store.setPlaybackRate(state.playbackRate);
          applied = true;
        }
        if (typeof store.setPreservesPitch === 'function' && typeof state.preservesPitch === 'boolean') {
          store.setPreservesPitch(state.preservesPitch);
          applied = true;
        }
        if (typeof store.setAudioParams === 'function') {
          store.setAudioParams({
            reverbWetMix: state.reverbWetMix,
            lowBandDecibels: state.lowBandDecibels,
          });
          applied = true;
        }
        if (!applied && typeof store.applyState === 'function') {
          store.applyState(state);
          applied = true;
        }
        return { ok: applied };
      },
      args: [nextState],
    });
    return Boolean(results?.[0]?.result?.ok);
  } catch (error) {
    return false;
  }
}

function sendPopupState(port, tabId, captureStatusOverride) {
  const captureStatus = captureStatusOverride ?? captureStatusByTabId.get(tabId) ?? 'UNKNOWN';
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

async function queueStateForTab(tabId, nextState) {
  stateByTabId.set(tabId, nextState);
  saveState();
  await applyStateToTab(tabId, nextState);
}

async function broadcastToUrlPatterns(urlPatterns, stateUpdate) {
  const tabs = await chrome.tabs.query({ url: urlPatterns });
  for (const tab of tabs) {
    if (!tab.id) {
      continue;
    }
    const nextState = sanitizeState(stateUpdate, getState(tab.id));
    await queueStateForTab(tab.id, nextState);
  }
}

async function broadcastToYouTubeTabs(stateUpdate) {
  await broadcastToUrlPatterns(DEFAULT_BROADCAST_URLS, stateUpdate);
}

function handlePopupPort(port) {
  port.onMessage.addListener(async (message) => {
    if (message?.type === 'POPUP_CONNECT' && message.tabId) {
      await storageReadyPromise;
      popupPorts.set(port, message.tabId);
      const captureStatus = await getCaptureStatusFromTab(message.tabId);
      sendPopupState(port, message.tabId, captureStatus);
      await queueStateForTab(message.tabId, getState(message.tabId));
      return;
    }

    if (message?.type === 'POPUP_UPDATE' && message.tabId && message.state) {
      const nextState = sanitizeState(message.state, getState(message.tabId));
      queueStateForTab(message.tabId, nextState);
      notifyPopupsForTab(message.tabId);
    }
  });

  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
  });
}


function tabAction(action) {
  const media = document.querySelector('video, audio');
  if (!media) {
    return;
  }
  if (action === 'play') {
    media.play();
  } else if (action === 'pause') {
    media.pause();
  }
}

function controlTabPlayback(tabId, action) {
  chrome.scripting.executeScript({
    target: { tabId: Number(tabId) },
    func: tabAction,
    args: [action],
  });
}

function handleServerCommand(command) {
  console.log('AudioRemix] recieved a command-', command)
  if (!command || typeof command !== 'object') {
    return;
  }

  const { action, tabId } = command;
  if (!action || !tabId) {
    return;
  }

  if (action === 'play' || action === 'pause') {
    controlTabPlayback(tabId, action);
    return;
  }

  if (action === 'setAudio' && command.state) {
    const nextState = sanitizeState(command.state, getState(tabId));
    stateByTabId.set(tabId, nextState);
    applyStateToTabWithSetters(tabId, nextState);
    notifyPopupsForTab(tabId);
  }
}

function scheduleTabsPush() {
  if (tabsPushTimer) {
    clearTimeout(tabsPushTimer);
  }
  tabsPushTimer = setTimeout(pushTabsToServer, 200);
}

async function pushTabsToServer() {
  tabsPushTimer = null;
  let tabs = [];

  try {
    const rawTabs = await chrome.tabs.query({ windowType: 'normal' });
    tabs = rawTabs
      .filter((tab) => tab.id && tab.url && tab.url.startsWith('http'))
      .map((tab) => ({
        id: tab.id,
        title: tab.title || 'Untitled Tab',
        url: tab.url,
        audible: !!tab.audible,
        muted: !!tab.mutedInfo?.muted,
      }));
  } catch (error) {
    return;
  }

  try {
    await fetch(`${SERVER_URL}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tabs),
    });
  } catch (error) {
    // Ignore server failures.
  }
}

function scheduleServerReconnect() {
  if (serverReconnectTimer) {
    return;
  }
  serverReconnectTimer = setTimeout(() => {
    serverReconnectTimer = null;
    connectToServer();
  }, 2000);
}

function connectToServer() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  try {
    eventSource = new EventSource(`${SERVER_URL}/events`);
  } catch (error) {
    scheduleServerReconnect();
    return;
  }

  eventSource.onmessage = (event) => {
    try {
      const command = JSON.parse(event.data);
      handleServerCommand(command);
    } catch (error) {
      // Ignore malformed messages.
    }
  };

  eventSource.onerror = () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    scheduleServerReconnect();
  };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    handlePopupPort(port);
  }
});

async function getCaptureStatusFromTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const store = window.__audioRemixStore;
        if (!store || typeof store.getCaptureStatus !== 'function') {
          return 'UNKNOWN';
        }
        return store.getCaptureStatus();
      },
    });
    return results?.[0]?.result || 'UNKNOWN';
  } catch (error) {
    return 'UNKNOWN';
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  stateByTabId.delete(tabId);
  captureStatusByTabId.delete(tabId);
  pendingInjection.delete(tabId);
  saveState();
  scheduleTabsPush();
});

chrome.tabs.onUpdated.addListener(() => scheduleTabsPush());
chrome.tabs.onActivated.addListener(() => scheduleTabsPush());
chrome.tabs.onCreated.addListener(() => scheduleTabsPush());
chrome.runtime.onInstalled.addListener(() => scheduleTabsPush());
chrome.runtime.onStartup.addListener(() => {
  scheduleTabsPush();
  connectToServer();
});

connectToServer();

// Expose helpers for manual testing in the service worker console.
self.broadcastToYouTubeTabs = broadcastToYouTubeTabs;
self.broadcastToUrlPatterns = broadcastToUrlPatterns;
