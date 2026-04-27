(() => {
  'use strict';

  const STORAGE_KEY = 'savedPresets';
  const EPSILON = 0.0001;

  const OFF_STATE = {
    playbackRate: 1,
    reverbAmount: 0,
    lowBandDecibels: 0,
    preservesPitch: false,
    volume: 1,
    delayTime: 0,
    delayFeedback: 0,
    delayWet: 0.4,
    eq: [0, 0, 0, 0, 0, 0, 0, 0],
  };

  const DEFAULT_PRESETS = {
    a: {
      name: 'Slot A',
      playbackRate: 0.8,
      reverbAmount: 0.4,
      lowBandDecibels: 0,
      preservesPitch: false,
      volume: 1,
      delayTime: 0,
      delayFeedback: 0,
      delayWet: 0.4,
      eq: [0, 0, 0, 0, 0, 0, 0, 0],
    },
    b: {
      name: 'Slot B',
      playbackRate: 1.2,
      reverbAmount: 0,
      lowBandDecibels: 0,
      preservesPitch: false,
      volume: 1,
      delayTime: 0,
      delayFeedback: 0,
      delayWet: 0.4,
      eq: [0, 0, 0, 0, 0, 0, 0, 0],
    },
  };

  const DEFAULT_STATE = {
    playbackRate: 1,
    reverbAmount: 0.4,
    lowBandDecibels: 0,
    preservesPitch: false,
    volume: 1,
    delayTime: 0,
    delayFeedback: 0,
    delayWet: 0.4,
    eq: [0, 0, 0, 0, 0, 0, 0, 0],
  };

  let savedPresets = {
    a: { ...DEFAULT_PRESETS.a },
    b: { ...DEFAULT_PRESETS.b },
  };

  const elements = {
    status: document.getElementById('status'),
    playbackSlider: document.getElementById('playback-rate'),
    reverbAmountSlider: document.getElementById('reverb-amount'),
    bassSlider: document.getElementById('low-band-decibels'),
    delayTimeSlider: document.getElementById('delay-time'),
    delayFeedbackSlider: document.getElementById('delay-feedback'),
    delayWetSlider: document.getElementById('delay-wet'),
    volumeSlider: document.getElementById('volume'),
    preserveToggle: document.getElementById('preserve-pitch'),
    playbackValue: document.getElementById('playback-rate-value'),
    reverbAmountValue: document.getElementById('reverb-amount-value'),
    bassValue: document.getElementById('low-band-decibels-value'),
    delayTimeValue: document.getElementById('delay-time-value'),
    delayFeedbackValue: document.getElementById('delay-feedback-value'),
    delayWetValue: document.getElementById('delay-wet-value'),
    volumeValue: document.getElementById('volume-value'),
    eqSliders: Array.from(document.querySelectorAll('.eq-slider')),
    eqValues: Array.from(document.querySelectorAll('.eq-value')),
  };

  let port = null;
  let activeTabId = null;
  let currentState = { ...DEFAULT_STATE };
  let activePresetKey = null;

  function nearlyEqual(a, b) {
    return Math.abs(a - b) < EPSILON;
  }

  function stateMatchesPreset(state, preset) {
    const stateEq = state.eq || Array(8).fill(0);
    const presetEq = preset.eq || Array(8).fill(0);
    return (
      nearlyEqual(state.playbackRate, preset.playbackRate) &&
      nearlyEqual(state.reverbAmount ?? 0.4, preset.reverbAmount ?? 0.4) &&
      nearlyEqual(state.lowBandDecibels, preset.lowBandDecibels) &&
      nearlyEqual(state.volume ?? 1, preset.volume ?? 1) &&
      nearlyEqual(state.delayTime ?? 0, preset.delayTime ?? 0) &&
      nearlyEqual(state.delayFeedback ?? 0, preset.delayFeedback ?? 0) &&
      nearlyEqual(state.delayWet ?? 0.4, preset.delayWet ?? 0.4) &&
      state.preservesPitch === preset.preservesPitch &&
      stateEq.every((v, i) => nearlyEqual(v, presetEq[i]))
    );
  }

  function getNameInputValue(key) {
    const input = document.querySelector(`.preset-name[data-preset="${key}"]`);
    return input ? input.value.trim() : '';
  }

  function isPresetDirty(key) {
    const stateDirty = !stateMatchesPreset(currentState, savedPresets[key]);
    const savedName = savedPresets[key].name || DEFAULT_PRESETS[key].name;
    const nameDirty = getNameInputValue(key) !== savedName;
    return stateDirty || nameDirty;
  }

  function findMatchingPreset(state) {
    if (stateMatchesPreset(state, OFF_STATE)) return 'off';
    for (const key of ['a', 'b']) {
      if (stateMatchesPreset(state, savedPresets[key])) return key;
    }
    return null;
  }

  function formatPlayback(v)  { return `${v.toFixed(2)}x`; }
  function formatPercent(v)   { return `${Math.round(v * 100)}%`; }
  function formatBass(v)      { return `${v.toFixed(1)} dB`; }
  function formatDelay(v)     { return `${Math.round(v * 1000)} ms`; }
  function formatEq(v)        { return v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1); }

  function updatePresetButtons() {
    ['a', 'b'].forEach((key) => {
      const item = document.querySelector(`.preset-item[data-preset="${key}"]`);
      const saveBtn = document.querySelector(`.preset-save[data-preset="${key}"]`);
      if (!item || !saveBtn) return;
      item.classList.toggle('is-active', activePresetKey === key);
      saveBtn.disabled = activePresetKey !== key || !isPresetDirty(key);
    });

    const offItem = document.querySelector('.preset-item[data-preset="off"]');
    if (offItem) offItem.classList.toggle('is-active', activePresetKey === 'off');
  }

  function updateStatus(captureStatus) {
    const status = elements.status;
    if (!captureStatus || captureStatus === 'ALL_CAPTURED' || captureStatus === 'UNKNOWN') {
      status.textContent = '';
      status.classList.add('status--hidden');
      return;
    }
    status.textContent =
      captureStatus === 'NO_MEDIA' ? 'No audio or video detected on this page.' :
      captureStatus === 'HAS_UNCAPTURABLE' ? 'Some media elements cannot be captured.' : '';
    status.classList.toggle('status--hidden', !status.textContent);
  }

  function renderState(state) {
    elements.playbackSlider.value = state.playbackRate;
    elements.reverbAmountSlider.value = state.reverbAmount ?? 0.4;
    elements.bassSlider.value = state.lowBandDecibels;
    elements.delayTimeSlider.value = state.delayTime ?? 0;
    elements.delayFeedbackSlider.value = state.delayFeedback ?? 0;
    elements.delayWetSlider.value = state.delayWet ?? 0.4;
    elements.volumeSlider.value = state.volume ?? 1;
    elements.preserveToggle.checked = state.preservesPitch;

    elements.playbackValue.textContent = formatPlayback(state.playbackRate);
    elements.reverbAmountValue.textContent = formatPercent(state.reverbAmount ?? 0.4);
    elements.bassValue.textContent = formatBass(state.lowBandDecibels);
    elements.delayTimeValue.textContent = formatDelay(state.delayTime ?? 0);
    elements.delayFeedbackValue.textContent = formatPercent(state.delayFeedback ?? 0);
    elements.delayWetValue.textContent = formatPercent(state.delayWet ?? 0.4);
    elements.volumeValue.textContent = formatPercent(state.volume ?? 1);

    const eq = state.eq || Array(8).fill(0);
    elements.eqSliders.forEach((s, i) => { s.value = eq[i] ?? 0; });
    elements.eqValues.forEach((v, i) => { v.textContent = formatEq(eq[i] ?? 0); });

    updatePresetButtons();
  }

  function setState(partial, emit = true) {
    currentState = { ...currentState, ...partial };
    renderState(currentState);

    if (emit && port && activeTabId) {
      port.postMessage({ type: 'POPUP_UPDATE', tabId: activeTabId, state: currentState });
    }
  }

  function applyPreset(key) {
    activePresetKey = key;
    if (key === 'off') {
      setState({ ...OFF_STATE }, true);
      return;
    }
    const preset = savedPresets[key];
    if (!preset) return;
    setState({ ...preset }, true);
  }

  async function savePreset(key) {
    const name = getNameInputValue(key) || DEFAULT_PRESETS[key].name;
    savedPresets[key] = { ...currentState, name };
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: savedPresets });
    } catch (e) {
      console.warn('[AudioBonanza] Failed to save preset', e);
    }
    updatePresetButtons();
  }

  function syncNameInputs() {
    ['a', 'b'].forEach((key) => {
      const input = document.querySelector(`.preset-name[data-preset="${key}"]`);
      if (input) input.value = savedPresets[key].name || DEFAULT_PRESETS[key].name;
    });
  }

  async function loadSavedPresets() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      if (data[STORAGE_KEY]) {
        savedPresets = {
          a: { ...DEFAULT_PRESETS.a, ...data[STORAGE_KEY].a },
          b: { ...DEFAULT_PRESETS.b, ...data[STORAGE_KEY].b },
        };
      }
    } catch (e) {
      console.warn('[AudioBonanza] Failed to load presets', e);
    }
    syncNameInputs();
  }

  function handleSliderInput() {
    setState({
      playbackRate: parseFloat(elements.playbackSlider.value),
      reverbAmount: parseFloat(elements.reverbAmountSlider.value),
      lowBandDecibels: parseFloat(elements.bassSlider.value),
      delayTime: parseFloat(elements.delayTimeSlider.value),
      delayFeedback: parseFloat(elements.delayFeedbackSlider.value),
      delayWet: parseFloat(elements.delayWetSlider.value),
      volume: parseFloat(elements.volumeSlider.value),
      eq: elements.eqSliders.map((s) => parseFloat(s.value)),
    });
  }

  function attachListeners() {
    [
      elements.playbackSlider,
      elements.reverbAmountSlider,
      elements.bassSlider,
      elements.delayTimeSlider,
      elements.delayFeedbackSlider,
      elements.delayWetSlider,
      elements.volumeSlider,
      ...elements.eqSliders,
    ].forEach((s) => s.addEventListener('input', handleSliderInput));

    elements.playbackSlider.addEventListener('dblclick', () => setState({ playbackRate: DEFAULT_STATE.playbackRate }));
    elements.reverbAmountSlider.addEventListener('dblclick', () => setState({ reverbAmount: DEFAULT_STATE.reverbAmount }));
    elements.bassSlider.addEventListener('dblclick', () => setState({ lowBandDecibels: DEFAULT_STATE.lowBandDecibels }));
    elements.delayTimeSlider.addEventListener('dblclick', () => setState({ delayTime: DEFAULT_STATE.delayTime }));
    elements.delayFeedbackSlider.addEventListener('dblclick', () => setState({ delayFeedback: DEFAULT_STATE.delayFeedback }));
    elements.delayWetSlider.addEventListener('dblclick', () => setState({ delayWet: DEFAULT_STATE.delayWet }));
    elements.volumeSlider.addEventListener('dblclick', () => setState({ volume: DEFAULT_STATE.volume }));

    elements.eqSliders.forEach((s, i) => {
      s.addEventListener('dblclick', () => {
        const newEq = [...(currentState.eq || Array(8).fill(0))];
        newEq[i] = 0;
        setState({ eq: newEq });
      });
    });

    elements.preserveToggle.addEventListener('change', (e) => setState({ preservesPitch: e.target.checked }));

    document.querySelectorAll('.preset-apply').forEach((btn) => {
      btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
    });

    document.querySelectorAll('.preset-save').forEach((btn) => {
      btn.addEventListener('click', () => savePreset(btn.dataset.preset));
    });

    document.querySelectorAll('.preset-name').forEach((input) => {
      input.addEventListener('mousedown', (e) => {
        if (activePresetKey !== input.dataset.preset) {
          e.preventDefault();
          applyPreset(input.dataset.preset);
        }
      });
      input.addEventListener('input', updatePresetButtons);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') {
          input.value = savedPresets[input.dataset.preset]?.name || DEFAULT_PRESETS[input.dataset.preset]?.name || '';
          input.blur();
          updatePresetButtons();
        }
      });
    });
  }

  async function connect() {
    port = chrome.runtime.connect({ name: 'popup' });

    port.onMessage.addListener((message) => {
      if (message?.type === 'POPUP_STATE' && message.state) {
        activeTabId = message.tabId || activeTabId;
        currentState = { ...DEFAULT_STATE, ...message.state };
        activePresetKey = findMatchingPreset(currentState);
        renderState(currentState);
        updateStatus(message.captureStatus);
      }
    });

    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return;

    activeTabId = tab.id;
    port.postMessage({ type: 'POPUP_CONNECT', tabId: activeTabId });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    attachListeners();
    renderState(currentState);
    await loadSavedPresets();
    updatePresetButtons();
    connect();
  });
})();
