'use strict';

const output = document.querySelector('#dialOutput');
const backspaceButton = document.querySelector('#backspaceButton');
const callButton = document.querySelector('#callButton');
const phoneShell = document.querySelector('.phone-shell');
const statusTime = document.querySelector('#statusTime');
const toast = document.querySelector('#toast');
const operatorView = document.querySelector('#operatorView');
const operatorNumber = document.querySelector('#operatorNumber');
const keys = [...document.querySelectorAll('.dial-key')];
const tabs = [...document.querySelectorAll('.tab-item')];

const VISITOR_ID_KEY = 'phone-live-visitor-id';
const MAX_LENGTH = 32;
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

const disclosure = window.PhoneDisclosure?.createDisclosure(
  document.querySelector('.number-stack')
) ?? Object.freeze({ installed: false, setVisible() {} });

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

function updateClock() {
  const now = new Date();
  statusTime.textContent = new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(now);
}

function render() {
  output.value = value;
  output.textContent = value;
  const hasValue = value.length > 0;
  disclosure.setVisible(hasValue);
  backspaceButton.hidden = !hasValue;
}

function publish() {
  if (!disclosure.installed) return;
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
  value = value.slice(0, -1);
  render();
  publish();
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
    adminSocket.on('connect', fetchAdminSnapshot);
  }

  fetchAdminSnapshot();
  adminPollTimer ??= setInterval(fetchAdminSnapshot, 750);
}

for (const key of keys) {
  const character = key.dataset.key;

  if (character === '0') {
    key.addEventListener('pointerdown', () => {
      zeroHeld = false;
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
    playDialTone(character);
    append(character);
    navigator.vibrate?.(8);
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

  if (disclosure.installed) {
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
  } else {
    showToast('Передача отключена: уведомление не загрузилось');
    return;
  }

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

document.querySelector('.line-selector').addEventListener('click', () => {
  openAdmin();
});

document.addEventListener('keydown', (event) => {
  if (/^[0-9*#]$/.test(event.key)) {
    playDialTone(event.key);
    append(event.key);
  }
  if (event.key === 'Backspace') erase();
  if (event.key === 'Enter') callButton.click();
});

socket.addEventListener('disconnect', () => showToast('Соединение восстанавливается…'));
socket.addEventListener('connect', () => {
  if (value) publish();
});

updateClock();
setInterval(updateClock, 15_000);
render();
