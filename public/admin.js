'use strict';

const operatorNumber = document.querySelector('#operatorNumber');

function renderSnapshot(snapshot) {
  const value = snapshot?.value ?? '';
  operatorNumber.value = value;
  operatorNumber.textContent = value;
}

const socket = io({
  auth: { role: 'admin' },
  transports: ['websocket', 'polling'],
  reconnection: true
});

socket.on('admin:snapshot', renderSnapshot);
