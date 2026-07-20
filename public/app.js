'use strict';

const output = document.querySelector('#dialOutput');
const backspaceButton = document.querySelector('#backspaceButton');
const callButton = document.querySelector('#callButton');
const statusTime = document.querySelector('#statusTime');
const toast = document.querySelector('#toast');
const keys = [...document.querySelectorAll('.dial-key')];
const tabs = [...document.querySelectorAll('.tab-item')];

const VISITOR_ID_KEY = 'phone-live-visitor-id';
const MAX_LENGTH = 32;
let value = '';
let toastTimer;
let zeroHoldTimer;
let zeroHeld = false;

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
  socket.emit('dial:update', { value });
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

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 1800);
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
    socket.emit('dial:submit', { value });
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
  showToast('Используется основная линия');
});

document.addEventListener('keydown', (event) => {
  if (/^[0-9*#]$/.test(event.key)) append(event.key);
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
