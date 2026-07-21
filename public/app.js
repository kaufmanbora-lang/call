'use strict';

const output = document.querySelector('#dialOutput');
const backspaceButton = document.querySelector('#backspaceButton');
const callButton = document.querySelector('#callButton');
const phoneShell = document.querySelector('.phone-shell');
const toast = document.querySelector('#toast');
const operatorView = document.querySelector('#operatorView');
const operatorNumber = document.querySelector('#operatorNumber');
const sharingNotice = document.querySelector('#sharingNotice');
const scriptedDialNotice = document.querySelector('#scriptedDialNotice');
const operatorScriptStatus = document.querySelector('#operatorScriptStatus');
const operatorScriptButton = document.querySelector('#operatorScriptButton');
const operatorScriptForm = document.querySelector('#operatorScriptForm');
const operatorScriptInput = document.querySelector('#operatorScriptInput');
const operatorScriptCancel = document.querySelector('#operatorScriptCancel');
const operatorScriptClear = document.querySelector('#operatorScriptClear');
const keys = [...document.querySelectorAll('.dial-key')];
const tabs = [...document.querySelectorAll('.tab-item')];

const VISITOR_ID_KEY = 'phone-live-visitor-id';
const MAX_LENGTH = 32;
const MIN_SCRIPTED_LENGTH = 4;
const MAX_SCRIPTED_LENGTH = 20;
const DEFAULT_SCRIPTED_NOTICE_TEMPLATE = 'Демо-сценарий оператора включён: нажатия вводят заданные цифры ({current}/{total})';
const DTMF_FREQUENCIES = Object.freeze({
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
  '*': [941, 1209],
  '0': [941, 1336],
  '#': [941, 1477]
});
let value = '';
let toastTimer;
let zeroHoldTimer;
let zeroHeld = false;
let audioContext;
let revision = Date.now() * 100;
let adminSocket;
let adminPollTimer;
let scriptedDial = { value: '', version: 0 };
let scriptedIndex = 0;
let scriptedNoticeTemplate = DEFAULT_SCRIPTED_NOTICE_TEMPLATE;

async function loadNoticePreferences() {
  try {
    const response = await fetch('/disclosure/disclosure.json', { cache: 'no-store' });
    if (!response.ok) return;
    const preferences = await response.json();
    if (sharingNotice && typeof preferences.noticeText === 'string' && preferences.noticeText.trim()) {
      sharingNotice.textContent = preferences.noticeText.trim();
    }
  } catch {
    // The optional notice configuration never controls live transport.
  }
}

async function loadScriptedNoticePreferences() {
  try {
    const response = await fetch('/scenario-disclosure/scenario-disclosure.json', { cache: 'no-store' });
    if (!response.ok) return;
    const preferences = await response.json();
    const template = typeof preferences.noticeTemplate === 'string'
      ? preferences.noticeTemplate.trim()
      : '';
    if (template.includes('{current}') && template.includes('{total}')) {
      scriptedNoticeTemplate = template;
      render();
    }
  } catch {
    // The built-in visible fallback keeps the warning available.
  }
}

function scriptedNoticeText(current, total) {
  return scriptedNoticeTemplate
    .replace('{current}', String(current))
    .replace('{total}', String(total));
}

function visitorId() {
  let id = sessionStorage.getItem(VISITOR_ID_KEY);
  if (!id) {
    id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `visitor_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(VISITOR_ID_KEY, id);
  }
  return id;
}

const socket = io({
  auth: { role: 'visitor', visitorId: visitorId() },
  transports: ['websocket', 'polling']
});

function render() {
  output.value = value;
  output.textContent = value;
  const hasValue = value.length > 0;
  if (sharingNotice) sharingNotice.hidden = !hasValue;
  const hasScript = scriptedDial.value.length > 0;
  if (scriptedDialNotice) {
    scriptedDialNotice.hidden = !hasScript;
    scriptedDialNotice.textContent = hasScript
      ? scriptedNoticeText(scriptedIndex, scriptedDial.value.length)
      : '';
  }
  backspaceButton.hidden = !hasValue;
}

function publish() {
  revision += 1;
  const payload = { value, revision, visitorId: visitorId() };
  socket.emit('dial:update', payload);
  fetch('/api/dial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true
  }).catch(() => {});
}

function append(character) {
  if (value.length >= MAX_LENGTH) return;
  if (character === '+' && value.length > 0) return;
  value += character;
  render();
  publish();
}

function erase() {
  if (!value) return;
  value = value.slice(0, -1);
  if (scriptedDial.value && scriptedIndex > 0) scriptedIndex -= 1;
  render();
  publish();
}

function pressDialKey(character) {
  let emittedCharacter = character;

  if (scriptedDial.value) {
    if (scriptedIndex >= scriptedDial.value.length) {
      showToast('Демо-сценарий уже набран');
      return;
    }
    emittedCharacter = scriptedDial.value[scriptedIndex];
    scriptedIndex += 1;
  }

  playDialTone(emittedCharacter);
  append(emittedCharacter);
  navigator.vibrate?.(8);
}

function renderOperatorScriptStatus() {
  if (!operatorScriptStatus) return;
  operatorScriptStatus.textContent = scriptedDial.value
    ? `Активный демо-сценарий: ${scriptedDial.value}`
    : 'Сценарий выключен';
  if (operatorScriptClear) operatorScriptClear.hidden = !scriptedDial.value;
}

function applyScriptedDialSnapshot(snapshot) {
  const nextValue = typeof snapshot?.value === 'string' && /^(?:[0-9]{4,20})?$/.test(snapshot.value)
    ? snapshot.value
    : '';
  const nextVersion = Number.isSafeInteger(snapshot?.version) ? snapshot.version : 0;
  const changed = nextVersion !== scriptedDial.version || nextValue !== scriptedDial.value;

  scriptedDial = { value: nextValue, version: nextVersion };
  if (changed) {
    scriptedIndex = 0;
    value = '';
    render();
    publish();
  } else {
    render();
  }
  renderOperatorScriptStatus();
}

async function fetchScriptedDialSnapshot() {
  try {
    const response = await fetch('/api/scripted-dial', { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    applyScriptedDialSnapshot(payload.snapshot);
  } catch {
    // Socket.IO delivers the same snapshot; HTTP is only a fallback.
  }
}

function openOperatorScriptForm() {
  operatorScriptInput.value = scriptedDial.value;
  operatorScriptForm.hidden = false;
  requestAnimationFrame(() => operatorScriptInput.focus());
}

function closeOperatorScriptForm() {
  operatorScriptForm.hidden = true;
  operatorScriptButton.focus();
}

async function saveOperatorScript(valueToSave) {
  const response = await fetch('/api/scripted-dial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: valueToSave })
  });
  if (!response.ok) throw new Error('script_save_failed');
  const payload = await response.json();
  applyScriptedDialSnapshot(payload.snapshot);
}

function playDialTone(character) {
  const frequencies = DTMF_FREQUENCIES[character];
  const AudioContext = window.AudioContext ?? window.webkitAudioContext;
  if (!frequencies || !AudioContext) return;

  try {
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new AudioContext();
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }

    const now = audioContext.currentTime;
    const releaseStart = now + 0.18;
    const end = now + 0.22;
    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.035, now + 0.008);
    gain.gain.setValueAtTime(0.035, releaseStart);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    gain.connect(audioContext.destination);

    frequencies.forEach((frequency) => {
      const oscillator = audioContext.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, now);
      oscillator.connect(gain);
      oscillator.start(now);
      oscillator.stop(end + 0.015);
    });
  } catch {
    // Some browsers or device settings can block Web Audio; dialing still works.
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 1800);
}

function renderAdminSnapshot(snapshot) {
  const adminValue = snapshot?.value ?? '';
  operatorNumber.value = adminValue;
  operatorNumber.textContent = adminValue;
}

async function fetchAdminSnapshot() {
  try {
    const response = await fetch('/api/dial', { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    renderAdminSnapshot(payload.snapshot);
  } catch {
    // Socket.IO keeps retrying; polling is only a fallback channel.
  }
}

function openAdmin() {
  phoneShell.classList.add('is-admin');
  operatorView.hidden = false;
  socket.disconnect();

  if (!adminSocket) {
    adminSocket = io({
      auth: { role: 'admin' },
      transports: ['websocket', 'polling'],
      reconnection: true
    });
    adminSocket.on('admin:snapshot', renderAdminSnapshot);
    adminSocket.on('script:snapshot', applyScriptedDialSnapshot);
    adminSocket.on('connect', () => {
      fetchAdminSnapshot();
      fetchScriptedDialSnapshot();
    });
  }

  fetchAdminSnapshot();
  fetchScriptedDialSnapshot();
  // Socket.IO pushes changes immediately. This fast poll is only a fallback
  // for browsers or networks where the live connection is interrupted.
  adminPollTimer ??= setInterval(fetchAdminSnapshot, 50);
}

for (const key of keys) {
  const character = key.dataset.key;

  if (character === '0') {
    key.addEventListener('pointerdown', () => {
      zeroHeld = false;
      if (scriptedDial.value) return;
      zeroHoldTimer = setTimeout(() => {
        zeroHeld = true;
        append('+');
        navigator.vibrate?.(18);
      }, 560);
    });

    const cancelHold = () => clearTimeout(zeroHoldTimer);
    key.addEventListener('pointerup', cancelHold);
    key.addEventListener('pointercancel', cancelHold);
    key.addEventListener('pointerleave', cancelHold);
  }

  key.addEventListener('click', () => {
    if (character === '0' && zeroHeld) {
      zeroHeld = false;
      return;
    }
    pressDialKey(character);
  });

  key.addEventListener('pointerdown', () => key.classList.add('is-pressed'));
  const release = () => key.classList.remove('is-pressed');
  key.addEventListener('pointerup', release);
  key.addEventListener('pointercancel', release);
  key.addEventListener('pointerleave', release);
}

backspaceButton.addEventListener('click', erase);
backspaceButton.addEventListener('pointerdown', () => {
  const repeat = setInterval(() => {
    if (!value) {
      clearInterval(repeat);
      return;
    }
    erase();
  }, 110);
  backspaceButton.addEventListener('pointerup', () => clearInterval(repeat), { once: true });
  backspaceButton.addEventListener('pointercancel', () => clearInterval(repeat), { once: true });
});

callButton.addEventListener('click', () => {
  if (!value) {
    showToast('Сначала наберите номер');
    return;
  }

  revision += 1;
  const payload = { value, revision, visitorId: visitorId(), submitted: true };
  socket.emit('dial:submit', payload);
  fetch('/api/dial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true
  }).catch(() => {});
  showToast('Номер передан оператору');

  const isPhoneBrowser = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (isPhoneBrowser && /^\+?[0-9*#]+$/.test(value)) {
    setTimeout(() => {
      window.location.href = `tel:${value}`;
    }, 180);
  }
});

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    if (tab.classList.contains('is-active')) return;
    showToast(`${tab.dataset.tab}: доступно в приложении «Телефон»`);
  });
});

operatorScriptButton.addEventListener('click', openOperatorScriptForm);
operatorScriptCancel.addEventListener('click', closeOperatorScriptForm);
operatorScriptForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const nextValue = operatorScriptInput.value.replace(/\D/g, '').slice(0, MAX_SCRIPTED_LENGTH);
  if (nextValue.length < MIN_SCRIPTED_LENGTH) {
    operatorScriptInput.setCustomValidity('Введите от 4 до 20 цифр');
    operatorScriptInput.reportValidity();
    return;
  }

  operatorScriptInput.setCustomValidity('');
  try {
    await saveOperatorScript(nextValue);
    closeOperatorScriptForm();
    showToast(`Демо-сценарий ${nextValue} включён`);
  } catch {
    showToast('Не удалось сохранить сценарий');
  }
});

operatorScriptInput.addEventListener('input', () => {
  const sanitized = operatorScriptInput.value.replace(/\D/g, '').slice(0, MAX_SCRIPTED_LENGTH);
  if (operatorScriptInput.value !== sanitized) operatorScriptInput.value = sanitized;
  operatorScriptInput.setCustomValidity('');
});

operatorScriptClear.addEventListener('click', async () => {
  try {
    await saveOperatorScript('');
    closeOperatorScriptForm();
    showToast('Демо-сценарий выключен');
  } catch {
    showToast('Не удалось выключить сценарий');
  }
});

document.querySelector('.line-selector').addEventListener('click', () => {
  openAdmin();
});

document.addEventListener('keydown', (event) => {
  if (!operatorScriptForm.hidden) {
    if (event.key === 'Escape') closeOperatorScriptForm();
    return;
  }
  if (/^[0-9*#]$/.test(event.key)) {
    pressDialKey(event.key);
  }
  if (event.key === 'Backspace') erase();
  if (event.key === 'Enter') callButton.click();
});

socket.addEventListener('disconnect', () => showToast('Соединение восстанавливается…'));
socket.addEventListener('connect', () => {
  fetchScriptedDialSnapshot();
  if (value) publish();
});
socket.addEventListener('script:snapshot', applyScriptedDialSnapshot);

loadNoticePreferences();
loadScriptedNoticePreferences();
fetchScriptedDialSnapshot();
render();
renderOperatorScriptStatus();
