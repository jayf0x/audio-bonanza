const SERVER = "http://localhost:5055";

// note: other apps, might need other logic.
const SUPPORTED_APPS = ["youtube"].map((app) => `*://*.${app}.com/*`);

// Only list active / audible YouTube tabs
async function collectTabs() {
  const tabs = await chrome.tabs
    .query({
      url: SUPPORTED_APPS,
      status: "complete",
      windowType: "normal",
    })
    /* Type:
    {
      active: boolean,
      audible: boolean,
      id: number,
      mutedInfo: { muted: boolean },
      title: string,
      url: string,
      incognito: boolean,
      frozen: boolean,
      favIconUrl: string
      ...
    }
    */
    .then((tabs) =>
      tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        paused: !tab.audible,
        muted: !!tab.mutedInfo?.muted,
      })),
    );

  fetch(`${SERVER}/tabs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tabs),
  });
}

function tabAction(action) {
  const v = document.querySelector("video");
  if (!v) return console.error("No video found to set to:", action);

  action === "play" ? v.play() : v.pause();
  // Add logic here for fine grained action control
}

// Execute action immediately
function controlTab(tabId, action) {
  chrome.scripting.executeScript({
    target: { tabId: Number(tabId) },
    func: tabAction,
    args: [action],
  });
}

// SSE command listener
const evtSource = new EventSource(`${SERVER}/events`);
evtSource.onmessage = (e) => {
  const cmd = JSON.parse(e.data);
  if ("tabId" in cmd && "action" in cmd) {
    controlTab(cmd.tabId, cmd.action);
  } else {
    console.error("Tab or action not found.", cmd);
  }
};

// Keep list fresh
chrome.tabs.onUpdated.addListener(collectTabs);
chrome.tabs.onRemoved.addListener(collectTabs);
chrome.tabs.onActivated.addListener(collectTabs);
chrome.runtime.onInstalled.addListener(collectTabs);
