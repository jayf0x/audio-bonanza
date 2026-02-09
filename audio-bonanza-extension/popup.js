(() => {
  'use strict';

  const PRESETS = {
    slowedandreverb: {
      playbackRate: 0.8,
      reverbWetMix: 0.4,
      lowBandDecibels: 0,
      preservesPitch: false,
    },
    nightcore: {
      playbackRate: 1.2,
      reverbWetMix: 0,
      lowBandDecibels: 0,
      preservesPitch: false,
    },
    off: {
      playbackRate: 1,
      reverbWetMix: 0,
      lowBandDecibels: 0,
      preservesPitch: false,
    },
  };

  const DEFAULT_STATE = { ...PRESETS.off };
  const EPSILON = 0.0001;

  const elements = {
    status: document.getElementById('status'),
    playbackSlider: document.getElementById('playback-rate'),
    reverbSlider: document.getElementById('reverb-wet-mix'),
    bassSlider: document.getElementById('low-band-decibels'),
    preserveToggle: document.getElementById('preserve-pitch'),
    playbackValue: document.getElementById('playback-rate-value'),
    reverbValue: document.getElementById('reverb-wet-mix-value'),
    bassValue: document.getElementById('low-band-decibels-value'),
    presetButtons: Array.from(document.querySelectorAll('.preset-btn')),
  };

  let port = null;
  let activeTabId = null;
  let currentState = { ...DEFAULT_STATE };

  function nearlyEqual(a, b) {
    return Math.abs(a - b) < EPSILON;
  }

  function formatPlayback(value) {
    return `${value.toFixed(2)}x`;
  }

  function formatReverb(value) {
    return `${Math.round(value * 100)}%`;
  }

  function formatBass(value) {
    return `${value.toFixed(1)} dB`;
  }

  function updatePresetButtons(state) {
    let matchedPreset = null;
    Object.entries(PRESETS).forEach(([key, preset]) => {
      const matches =
        nearlyEqual(state.playbackRate, preset.playbackRate) &&
        nearlyEqual(state.reverbWetMix, preset.reverbWetMix) &&
        nearlyEqual(state.lowBandDecibels, preset.lowBandDecibels) &&
        state.preservesPitch === preset.preservesPitch;
      if (matches) {
        matchedPreset = key;
      }
    });

    elements.presetButtons.forEach((button) => {
      button.classList.toggle('is-active', button.dataset.preset === matchedPreset);
    });
  }

  function updateStatus(captureStatus) {
    const status = elements.status;
    if (!captureStatus || captureStatus === 'ALL_CAPTURED' || captureStatus === 'UNKNOWN') {
      status.textContent = '';
      status.classList.add('status--hidden');
      return;
    }

    if (captureStatus === 'NO_MEDIA') {
      status.textContent = 'No audio or video detected on this page.';
    } else if (captureStatus === 'HAS_UNCAPTURABLE') {
      status.textContent = 'Some media elements cannot be captured.';
    } else {
      status.textContent = '';
    }

    status.classList.toggle('status--hidden', !status.textContent);
  }

  function renderState(state) {
    elements.playbackSlider.value = state.playbackRate;
    elements.reverbSlider.value = state.reverbWetMix;
    elements.bassSlider.value = state.lowBandDecibels;
    elements.preserveToggle.checked = state.preservesPitch;

    elements.playbackValue.textContent = formatPlayback(state.playbackRate);
    elements.reverbValue.textContent = formatReverb(state.reverbWetMix);
    elements.bassValue.textContent = formatBass(state.lowBandDecibels);

    updatePresetButtons(state);
  }

  function setState(partial, emit = true) {
    currentState = { ...currentState, ...partial };
    renderState(currentState);

    if (emit && port && activeTabId) {
      port.postMessage({
        type: 'POPUP_UPDATE',
        tabId: activeTabId,
        state: currentState,
      });
    }
  }

  function applyPreset(presetKey) {
    const preset = PRESETS[presetKey];
    if (!preset) {
      return;
    }
    setState(preset, true);
  }

  function handleSliderInput() {
    setState({
      playbackRate: parseFloat(elements.playbackSlider.value),
      reverbWetMix: parseFloat(elements.reverbSlider.value),
      lowBandDecibels: parseFloat(elements.bassSlider.value),
    });
  }

  function attachListeners() {
    elements.playbackSlider.addEventListener('input', handleSliderInput);
    elements.reverbSlider.addEventListener('input', handleSliderInput);
    elements.bassSlider.addEventListener('input', handleSliderInput);

    elements.playbackSlider.addEventListener('dblclick', () => {
      setState({ playbackRate: DEFAULT_STATE.playbackRate });
    });
    elements.reverbSlider.addEventListener('dblclick', () => {
      setState({ reverbWetMix: DEFAULT_STATE.reverbWetMix });
    });
    elements.bassSlider.addEventListener('dblclick', () => {
      setState({ lowBandDecibels: DEFAULT_STATE.lowBandDecibels });
    });

    elements.preserveToggle.addEventListener('change', (event) => {
      setState({ preservesPitch: event.target.checked });
    });

    elements.presetButtons.forEach((button) => {
      button.addEventListener('click', () => {
        applyPreset(button.dataset.preset);
      });
    });
  }

  async function connect() {
    port = chrome.runtime.connect({ name: 'popup' });

    port.onMessage.addListener((message) => {
      if (message?.type === 'POPUP_STATE' && message.state) {
        activeTabId = message.tabId || activeTabId;
        currentState = { ...DEFAULT_STATE, ...message.state };
        renderState(currentState);
        updateStatus(message.captureStatus);
      }
    });

    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.id) {
      return;
    }

    activeTabId = tab.id;
    port.postMessage({ type: 'POPUP_CONNECT', tabId: activeTabId });
  }

  document.addEventListener('DOMContentLoaded', () => {
    attachListeners();
    renderState(currentState);
    connect();
  });
})();
