"use strict";
(() => {
  // use as filter in console log
  const LOG_PREFIX = "[AudioRemix]";

  if (globalThis.__audioRemixStore) {
    const store = globalThis.__audioRemixStore;
    if (typeof store.refresh === "function") {
      store.refresh();
    }
    console.info(`${LOG_PREFIX} Reused existing audio graph.`);
    return;
  }

  globalThis.__audioRemixStore = {};
  globalThis.__audioRemixInjected = true;

  const DECAY_TIME_SECONDS = 5;
  const PRE_DELAY_SECONDS = 0.01;
  const CHANNEL_COUNT = 2;

  const CAPTURE_STATUS_NO_MEDIA = "NO_MEDIA";
  const CAPTURE_STATUS_HAS_UNCAPTURABLE = "HAS_UNCAPTURABLE";
  const CAPTURE_STATUS_ALL_CAPTURED = "ALL_CAPTURED";

  const DEFAULT_STATE = {
    playbackRate: 0.8,
    reverbWetMix: 0.4,
    lowBandDecibels: 0,
    preservesPitch: false,
    volume: 1,
    delayTime: 0,
    delayFeedback: 0,
  };
  const DETACH_GRACE_MS = 5000;

  function createWhiteNoiseBuffer(audioContext) {
    const buffer = audioContext.createBuffer(
      CHANNEL_COUNT,
      (DECAY_TIME_SECONDS + PRE_DELAY_SECONDS) * audioContext.sampleRate,
      audioContext.sampleRate,
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
      audioContext.sampleRate,
    );
    const bufferSource = offlineContext.createBufferSource();
    bufferSource.buffer = createWhiteNoiseBuffer(offlineContext);
    const gain = offlineContext.createGain();
    gain.gain.setValueAtTime(0, 0);
    gain.gain.setValueAtTime(1, PRE_DELAY_SECONDS);
    gain.gain.exponentialRampToValueAtTime(
      0.00001,
      DECAY_TIME_SECONDS + PRE_DELAY_SECONDS,
    );
    bufferSource.connect(gain);
    gain.connect(offlineContext.destination);
    const convolver = audioContext.createConvolver();
    bufferSource.start(0);
    convolver.buffer = await offlineContext.startRendering();
    return convolver;
  }

  const audioContext = new AudioContext();
  globalThis.__audioRemixStore.audioContext = audioContext;

  function resumeAudioContext() {
    if (audioContext.state !== "running") {
      audioContext.resume();
    }
    document.removeEventListener("click", resumeAudioContext);
  }

  document.addEventListener("click", resumeAudioContext);

  // Master gain routes all processed audio to the destination.
  const masterGain = audioContext.createGain();
  masterGain.gain.value = 1;
  masterGain.connect(audioContext.destination);

  const dryGain = audioContext.createGain();
  dryGain.connect(masterGain);

  const wetInput = audioContext.createGain();
  wetInput.gain.value = 1;

  const wetGain = audioContext.createGain();
  wetGain.connect(masterGain);

  const delayNode = audioContext.createDelay(1.0);
  const delayFeedbackGain = audioContext.createGain();
  const delayWetGain = audioContext.createGain();
  delayWetGain.gain.value = 0;
  delayNode.connect(delayFeedbackGain);
  delayFeedbackGain.connect(delayNode);
  delayNode.connect(delayWetGain);
  delayWetGain.connect(masterGain);

  createConvolver(audioContext).then((convolverNode) => {
    convolverNode.connect(wetGain);
    wetInput.connect(convolverNode);
    // Re-check for media elements now that the full audio graph is ready.
    updateAndWatchMediaElements(mediaElementStore.getMediaElements());
  });

  const lowshelfFilter = audioContext.createBiquadFilter();
  lowshelfFilter.type = "lowshelf";
  lowshelfFilter.frequency.value = 160;
  lowshelfFilter.connect(dryGain);
  lowshelfFilter.connect(wetInput);
  lowshelfFilter.connect(delayNode);

  let state = { ...DEFAULT_STATE };

  const mediaElementAttributeObserver = new MutationObserver((mutations) => {
    mutations.forEach(({ attributeName, target }) => {
      if (!(target instanceof HTMLMediaElement)) {
        return;
      }
      if (
        attributeName === "preservesPitch" &&
        target.preservesPitch !== state.preservesPitch
      ) {
        target.preservesPitch = state.preservesPitch;
      }
      if (
        attributeName === "playbackRate" &&
        target.playbackRate !== state.playbackRate
      ) {
        target.playbackRate = state.playbackRate;
      }
    });
  });

  const sourceNodesByMediaElements = new Map();
  const uncapturableMediaElementSet = new Set();
  const capturedMediaElements = new WeakSet();
  const pendingRemovalTimers = new Map();
  // Tracks elements we muted to silence the native audio path when using captureStream fallback.
  const mutedByExtension = new Set();
  globalThis.__audioRemixStore.sourceNodesByMediaElements = sourceNodesByMediaElements;
  globalThis.__audioRemixStore.uncapturableMediaElementSet = uncapturableMediaElementSet;

  function getMediaElements() {
    return Array.from(document.getElementsByTagName("audio")).concat(
      Array.from(document.getElementsByTagName("video")),
    );
  }

  function isCaptureSupported(mediaElement) {
    const hasCaptureStream = typeof mediaElement.captureStream === "function";
    const hasMozCaptureStream =
      !hasCaptureStream && typeof mediaElement.mozCaptureStream === "function";
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

  function applyStateToNodes() {
    wetGain.gain.value = state.reverbWetMix;
    dryGain.gain.value = Math.max(0, 1 - state.reverbWetMix);
    lowshelfFilter.gain.value = state.lowBandDecibels;
    masterGain.gain.value = state.volume ?? 1;
    delayNode.delayTime.value = state.delayTime ?? 0;
    delayFeedbackGain.gain.value = state.delayFeedback ?? 0;
    delayWetGain.gain.value = (state.delayTime ?? 0) > 0 ? 0.4 : 0;
  }

  function applyStateToMediaElements(mediaElements) {
    mediaElements.forEach((mediaElement) => {
      if (mediaElement.preservesPitch !== state.preservesPitch) {
        mediaElement.preservesPitch = state.preservesPitch;
      }
      if (mediaElement.playbackRate !== state.playbackRate) {
        mediaElement.playbackRate = state.playbackRate;
      }
    });
  }

  function setPlaybackRate(playbackRate) {
    if (typeof playbackRate !== "number" || !Number.isFinite(playbackRate)) {
      return;
    }
    state = { ...state, playbackRate };
    applyStateToMediaElements(mediaElementStore.getMediaElements());
  }

  function setPreservesPitch(preservesPitch) {
    if (typeof preservesPitch !== "boolean") {
      return;
    }
    state = { ...state, preservesPitch };
    applyStateToMediaElements(mediaElementStore.getMediaElements());
  }

  function setAudioParams({ reverbWetMix, lowBandDecibels, volume, delayTime, delayFeedback } = {}) {
    const nextState = { ...state };
    if (typeof reverbWetMix === "number" && Number.isFinite(reverbWetMix)) {
      nextState.reverbWetMix = reverbWetMix;
    }
    if (typeof lowBandDecibels === "number" && Number.isFinite(lowBandDecibels)) {
      nextState.lowBandDecibels = lowBandDecibels;
    }
    if (typeof volume === "number" && Number.isFinite(volume)) {
      nextState.volume = volume;
    }
    if (typeof delayTime === "number" && Number.isFinite(delayTime)) {
      nextState.delayTime = delayTime;
    }
    if (typeof delayFeedback === "number" && Number.isFinite(delayFeedback)) {
      nextState.delayFeedback = delayFeedback;
    }
    state = nextState;
    applyStateToNodes();
  }

  function clearPendingRemoval(mediaElement) {
    const timerId = pendingRemovalTimers.get(mediaElement);
    if (timerId) {
      clearTimeout(timerId);
      pendingRemovalTimers.delete(mediaElement);
    }
  }

  function isElementDetached(mediaElement) {
    if (mediaElement.isConnected) {
      return false;
    }
    const ownerDocument = mediaElement.ownerDocument;
    if (!ownerDocument) {
      return true;
    }
    return !ownerDocument.contains(mediaElement);
  }

  function scheduleRemoval(mediaElement) {
    if (pendingRemovalTimers.has(mediaElement)) {
      return;
    }
    const timerId = setTimeout(() => {
      pendingRemovalTimers.delete(mediaElement);
      if (!isElementDetached(mediaElement)) {
        return;
      }
      const sourceNode = sourceNodesByMediaElements.get(mediaElement);
      if (sourceNode) {
        sourceNode.disconnect();
        sourceNodesByMediaElements.delete(mediaElement);
      }
      if (mutedByExtension.has(mediaElement)) {
        mediaElement.muted = false;
        mutedByExtension.delete(mediaElement);
      }
      uncapturableMediaElementSet.delete(mediaElement);
    }, DETACH_GRACE_MS);
    pendingRemovalTimers.set(mediaElement, timerId);
  }

  function updateAndWatchMediaElements(mediaElements) {
    const mediaElementSet = new Set(mediaElements);

    Array.from(sourceNodesByMediaElements.keys()).forEach((mediaElement) => {
      if (mediaElementSet.has(mediaElement) && !isElementDetached(mediaElement)) {
        clearPendingRemoval(mediaElement);
        return;
      }
      scheduleRemoval(mediaElement);
    });

    Array.from(uncapturableMediaElementSet).forEach((mediaElement) => {
      if (mediaElementSet.has(mediaElement) && !isElementDetached(mediaElement)) {
        clearPendingRemoval(mediaElement);
        return;
      }
      scheduleRemoval(mediaElement);
    });

    mediaElements.forEach((mediaElement) => {
      mediaElementAttributeObserver.observe(mediaElement, {
        attributes: true,
        attributeFilter: ["preservesPitch", "playbackRate"],
      });

      if (
        sourceNodesByMediaElements.has(mediaElement) ||
        uncapturableMediaElementSet.has(mediaElement) ||
        capturedMediaElements.has(mediaElement)
      ) {
        clearPendingRemoval(mediaElement);
        return;
      }

      try {
        const wasPlaying = !mediaElement.paused;
        let sourceNode = null;

        try {
          // Preferred: MediaElementSource exclusively routes audio through Web Audio,
          // preventing the native audio path from playing alongside the processed path.
          sourceNode = audioContext.createMediaElementSource(mediaElement);
          console.info(`${LOG_PREFIX} Using MediaElementSource.`);
        } catch (primaryErr) {
          // DRM or cross-origin content — fall back to captureStream and mute native output.
          let stream = null;
          if (typeof mediaElement.captureStream === "function") {
            stream = mediaElement.captureStream();
          } else if (typeof mediaElement.mozCaptureStream === "function") {
            stream = mediaElement.mozCaptureStream();
          }
          if (stream) {
            sourceNode = audioContext.createMediaStreamSource(stream);
            if (!mediaElement.muted) {
              mediaElement.muted = true;
              mutedByExtension.add(mediaElement);
            }
            console.info(`${LOG_PREFIX} Using captureStream source (native muted).`);
          } else {
            if (primaryErr.name === "InvalidStateError") {
              capturedMediaElements.add(mediaElement);
            }
            uncapturableMediaElementSet.add(mediaElement);
            return;
          }
        }

        sourceNode.connect(lowshelfFilter);
        sourceNodesByMediaElements.set(mediaElement, sourceNode);
        capturedMediaElements.add(mediaElement);
        clearPendingRemoval(mediaElement);
        if (wasPlaying && mediaElement.paused) {
          mediaElement.play().catch(() => {});
        }
      } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to capture media element.`, error);
        if (error && error.name === "InvalidStateError") {
          capturedMediaElements.add(mediaElement);
        }
        uncapturableMediaElementSet.add(mediaElement);
      }
    });

    applyStateToMediaElements(mediaElements);
    applyStateToNodes();
  }

  function createMediaElementStore() {
    const listeners = [];
    const mediaElementSet = new Set(getMediaElements());

    const rootElementObserver = new MutationObserver((mutations) => {
      if (
        mutations.some(
          ({ addedNodes, removedNodes }) =>
            (addedNodes && addedNodes.length) ||
            (removedNodes && removedNodes.length),
        )
      ) {
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

    // Always observe the document root so dynamically-added media elements
    // (e.g. YouTube SPA navigation) are detected even when none exist at inject time.
    rootElementObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
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

  function applyState(nextState) {
    state = { ...state, ...nextState };
    applyStateToMediaElements(mediaElementStore.getMediaElements());
    applyStateToNodes();
  }

  globalThis.__audioRemixStore.setPlaybackRate = setPlaybackRate;
  globalThis.__audioRemixStore.setPreservesPitch = setPreservesPitch;
  globalThis.__audioRemixStore.setAudioParams = setAudioParams;
  globalThis.__audioRemixStore.applyState = applyState;
  globalThis.__audioRemixStore.getCaptureStatus = getCaptureStatus;
  globalThis.__audioRemixStore.refresh = () => {
    updateAndWatchMediaElements(mediaElementStore.getMediaElements());
  };

  mediaElementStore.subscribe(() => {
    updateAndWatchMediaElements(mediaElementStore.getMediaElements());
  });
})();
