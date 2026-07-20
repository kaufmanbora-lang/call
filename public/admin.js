'use strict';

const loginForm = document.querySelector('#adminLogin');
const passwordInput = document.querySelector('#adminPassword');
const loginError = document.querySelector('#loginError');
const operatorView = document.querySelector('#operatorView');
const operatorNumber = document.querySelector('#operatorNumber');

let socket;

function renderSnapshot(snapshot) {
  const value = snapshot?.value ?? '';
  operatorNumber.value = value;
  operatorNumber.textContent = value;
}

function connect(password) {
  socket?.disconnect();
  loginError.textContent = '';

  socket = io({
    auth: { role: 'admin', password },
    transports: ['websocket', 'polling'],
    reconnection: true
  });

  socket.on('connect', () => {
    loginForm.hidden = true;
    operatorView.hidden = false;
    passwordInput.value = '';
  });

  socket.on('admin:snapshot', renderSnapshot);

  socket.on('admin:denied', () => {
    operatorView.hidden = true;
    loginForm.hidden = false;
    loginError.textContent = 'Неверный пароль';
    passwordInput.focus();
  });

  socket.on('connect_error', () => {
    if (!operatorView.hidden) return;
    loginError.textContent = 'Не удалось подключиться. Попробуйте ещё раз.';
  });
}

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  connect(passwordInput.value);
});
