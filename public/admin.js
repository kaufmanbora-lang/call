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

async function fetchSnapshot() {
  try {
    const response = await fetch('/api/dial', { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    renderSnapshot(payload.snapshot);
  } catch {
    // Socket.IO keeps retrying; polling is only a fallback channel.
  }
}

socket.on('connect', fetchSnapshot);
fetchSnapshot();
setInterval(fetchSnapshot, 750);
