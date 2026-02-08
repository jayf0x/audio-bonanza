'use strict';

const DECAY_TIME_SECONDS = 5;
const PRE_DELAY_SECONDS = 0.01;
const CHANNEL_COUNT = 2;

const CAPTURE_STATUS_NO_MEDIA = 'NO_MEDIA';
const CAPTURE_STATUS_HAS_UNCAPTURABLE = 'HAS_UNCAPTURABLE';
const CAPTURE_STATUS_ALL_CAPTURED = 'ALL_CAPTURED';

const DEFAULT_STATE = {
  playbackRate: 0.8,
  reverbWetMix: 0.4,
  lowBandDecibels: 0,
  preservesPitch: false,
};

function createWhiteNoiseBuffer(audioContext) {
  const buffer = audioContext.createBuffer(
    CHANNEL_COUNT,
    (DECAY_TIME_SECONDS + PRE_DELAY_SECONDS) * audioContext.sampleRate,
    audioContext.sampleRate
  );
  for (let channelNum = 0; channelNum < CHANNEL_COUNT; channelNum++) {
    const channelData = buffer.getChannelData(channelNum);
    for (let i = 0; i < channelData.length; i++) {
      channelData[i] = Math.random() * 2 - 1;
    }
  }
  return buffer;
}

async function createConvolver(audioContext) {
  const offlineContext = new OfflineAudioContext(
    2,
    (DECAY_TIME_SECONDS + PRE_DELAY_SECONDS) * audioContext.sampleRate,
    audioContext.sampleRate
  );
  const bufferSource = offlineContext.createBufferSource();
  bufferSource.buffer = createWhiteNoiseBuffer(offlineContext);
  const gain = offlineContext.createGain();
  gain.gain.setValueAtTime(0, 0);
  gain.gain.setValueAtTime(1, PRE_DELAY_SECONDS);
  gain.gain.exponentialRampToValueAtTime(0.00001, DECAY_TIME_SECONDS + PRE_DELAY_SECONDS);
  bufferSource.connect(gain);
  gain.connect(offlineContext.destination);
  const convolver = audioContext.createConvolver();
  bufferSource.start(0);
  convolver.buffer = await offlineContext.startRendering();
  return convolver;
}

const audioContext = new AudioContext();

function resumeAudioContext() {
  if (audioContext.state !== 'running') {
    audioContext.resume();
  }
  document.removeEventListener('click', resumeAudioContext);
}

document.addEventListener('click', resumeAudioContext);

const dryGain = audioContext.createGain();
dryGain.connect(audioContext.destination);

const wetInput = audioContext.createGain();
wetInput.gain.value = 1;

const wetGain = audioContext.createGain();
wetGain.connect(audioContext.destination);

createConvolver(audioContext).then((convolverNode) => {
  convolverNode.connect(wetGain);
  wetInput.connect(convolverNode);
});

const lowshelfFilter = audioContext.createBiquadFilter();
lowshelfFilter.type = 'lowshelf';
lowshelfFilter.frequency.value = 160;
lowshelfFilter.connect(dryGain);
lowshelfFilter.connect(wetInput);

let state = { ...DEFAULT_STATE };

const mediaElementAttributeObserver = new MutationObserver((mutations) => {
  mutations.forEach(({ attributeName, target }) => {
    if (!(target instanceof HTMLMediaElement)) {
      return;
    }
    if (attributeName === 'preservesPitch' && target.preservesPitch !== state.preservesPitch) {
      target.preservesPitch = state.preservesPitch;
    }
    if (attributeName === 'playbackRate' && target.playbackRate !== state.playbackRate) {
      target.playbackRate = state.playbackRate;
    }
  });
});

const sourceNodesByMediaElements = new Map();
const uncapturableMediaElementSet = new Set();

function getMediaElements() {
  return Array.from(document.getElementsByTagName('audio')).concat(
    Array.from(document.getElementsByTagName('video'))
  );
}

function isCaptureSupported(mediaElement) {
  const hasCaptureStream = typeof mediaElement.captureStream === 'function';
  const hasMozCaptureStream = !hasCaptureStream && typeof mediaElement.mozCaptureStream === 'function';
  if (!hasCaptureStream && !hasMozCaptureStream) {
    return false;
  }
  try {
    if (hasCaptureStream && mediaElement.captureStream) {
      mediaElement.captureStream();
    } else if (hasMozCaptureStream && mediaElement.mozCaptureStream) {
      mediaElement.mozCaptureStream();
    }
    return true;
  } catch (error) {
    return false;
  }
}

function updateAndWatchMediaElements(mediaElements) {
  const mediaElementSet = new Set(mediaElements);

  Array.from(sourceNodesByMediaElements)
    .filter(([mediaElement]) => !mediaElementSet.has(mediaElement))
    .forEach(([mediaElement, sourceNode]) => {
      sourceNode.disconnect();
      sourceNodesByMediaElements.delete(mediaElement);
    });

  Array.from(uncapturableMediaElementSet)
    .filter((mediaElement) => !mediaElementSet.has(mediaElement))
    .forEach((mediaElement) => {
      uncapturableMediaElementSet.delete(mediaElement);
    });

  mediaElements.forEach((mediaElement) => {
    mediaElement.preservesPitch = state.preservesPitch;
    mediaElement.playbackRate = state.playbackRate;

    mediaElementAttributeObserver.observe(mediaElement, {
      attributes: true,
      attributeFilter: ['preservesPitch', 'playbackRate'],
    });

    if (sourceNodesByMediaElements.has(mediaElement) || uncapturableMediaElementSet.has(mediaElement)) {
      return;
    }

    if (!isCaptureSupported(mediaElement)) {
      uncapturableMediaElementSet.add(mediaElement);
      return;
    }

    const sourceNode = audioContext.createMediaElementSource(mediaElement);
    sourceNode.connect(lowshelfFilter);
    sourceNodesByMediaElements.set(mediaElement, sourceNode);
  });

  wetGain.gain.value = state.reverbWetMix;
  dryGain.gain.value = 1 - state.reverbWetMix;
  lowshelfFilter.gain.value = state.lowBandDecibels;
}

function createMediaElementStore() {
  const listeners = [];
  const mediaElementSet = new Set(getMediaElements());

  const rootElementObserver = new MutationObserver((mutations) => {
    if (mutations.some(({ addedNodes, removedNodes }) => (addedNodes && addedNodes.length) || (removedNodes && removedNodes.length))) {
      const currentMediaElementSet = new Set(getMediaElements());

      Array.from(mediaElementSet)
        .filter((mediaElement) => !currentMediaElementSet.has(mediaElement))
        .forEach((mediaElement) => {
          mediaElementSet.delete(mediaElement);
        });

      Array.from(currentMediaElementSet)
        .filter((mediaElement) => !mediaElementSet.has(mediaElement))
        .forEach((mediaElement) => {
          mediaElementSet.add(mediaElement);
        });

      listeners.forEach((listener) => listener());
    }
  });

  function startWatchingElement(mediaElement) {
    const rootElement = findRootElement(mediaElement);
    rootElementObserver.observe(rootElement, {
      subtree: true,
      childList: true,
    });
  }

  function findRootElement(htmlElement) {
    if (!htmlElement.parentElement) {
      return htmlElement;
    }
    return findRootElement(htmlElement.parentElement);
  }

  Array.from(mediaElementSet).forEach((mediaElement) => {
    startWatchingElement(mediaElement);
  });

  return {
    getMediaElements: () => Array.from(mediaElementSet),
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
  };
}

const mediaElementStore = createMediaElementStore();
updateAndWatchMediaElements(mediaElementStore.getMediaElements());

function getCaptureStatus() {
  if (uncapturableMediaElementSet.size > 0) {
    return CAPTURE_STATUS_HAS_UNCAPTURABLE;
  }
  if (sourceNodesByMediaElements.size > 0) {
    return CAPTURE_STATUS_ALL_CAPTURED;
  }
  return CAPTURE_STATUS_NO_MEDIA;
}

const port = chrome.runtime.connect({ name: 'content' });

function sendCaptureStatus() {
  try {
    port.postMessage({
      type: 'CONTENT_CAPTURE_STATUS',
      captureStatus: getCaptureStatus(),
    });
  } catch (error) {
    // Ignore send errors.
  }
}

port.postMessage({
  type: 'CONTENT_CONNECT',
  captureStatus: getCaptureStatus(),
});

port.onMessage.addListener((message) => {
  if (message?.type === 'CONTENT_STATE_UPDATE' && message.state) {
    state = { ...state, ...message.state };
    updateAndWatchMediaElements(mediaElementStore.getMediaElements());
  }
});

mediaElementStore.subscribe(() => {
  updateAndWatchMediaElements(mediaElementStore.getMediaElements());
  sendCaptureStatus();
});
