/* =========================================================
   SMARTSORT, MACHINE LINK
   Sends one command per decided item to a sorting controller, as a
   line of JSON:
     {"type":"sort","id":12,"category":"plastic","bin":"Plastic collection bin",
      "confidence":0.93,"x":0.41,"y":0.62,"w":0.18,"h":0.25,"ts":"..."}
   x/y are the item's centre in the camera frame (0..1 from the top
   left); mapping them to arm or gate positions is a calibration step
   on the controller. Uncertain items are sent as "manual" so the
   machine can divert them; they never trigger a material bin.
   Transports: USB serial (Web Serial, Chrome/Edge, e.g. Arduino or
   ESP32) or WebSocket. Every command is also fired as a
   "smartsort:command" DOM event. This link is not a safety system:
   the machine needs its own emergency stop and interlocks.
   ========================================================= */

const listeners = new Set();
const state = { transport: 'none', connected: false, error: null, sent: 0, log: [] };
let serialPort = null, writer = null, ws = null;
const enc = new TextEncoder();

export const status = () => ({ ...state, log: [...state.log] });
export const onChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(status()));

export const serialSupported = () => 'serial' in navigator;

export async function connectSerial(baud) {
  await disconnect();
  try {
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: Number(baud) || 115200 });
    writer = serialPort.writable.getWriter();
    Object.assign(state, { transport: 'serial', connected: true, error: null });
    serialPort.addEventListener('disconnect', () => { Object.assign(state, { connected: false, error: 'Controller unplugged.' }); emit(); });
    send({ type: 'hello', app: 'smartsort', version: 1 });
  } catch (e) {
    Object.assign(state, { transport: 'serial', connected: false, error: e.name === 'NotFoundError' ? 'No port selected.' : e.message });
  }
  emit();
}

export async function connectWebSocket(url) {
  await disconnect();
  Object.assign(state, { transport: 'websocket', connected: false, error: null });
  try {
    ws = new WebSocket(url);
    ws.onopen = () => { state.connected = true; state.error = null; send({ type: 'hello', app: 'smartsort', version: 1 }); emit(); };
    ws.onclose = () => { state.connected = false; emit(); };
    ws.onerror = () => { state.error = `Could not connect to ${url}.`; emit(); };
  } catch (e) { state.error = e.message; }
  emit();
}

export async function disconnect() {
  try { writer?.releaseLock(); await serialPort?.close(); } catch { /* already closed */ }
  try { ws?.close(); } catch { /* already closed */ }
  serialPort = writer = ws = null;
  Object.assign(state, { connected: false, transport: 'none' });
  emit();
}

export async function send(cmd) {
  const line = JSON.stringify({ ...cmd, ts: new Date().toISOString() });
  window.dispatchEvent(new CustomEvent('smartsort:command', { detail: JSON.parse(line) }));
  let delivered = false;
  try {
    if (writer && state.connected) { await writer.write(enc.encode(`${line}\n`)); delivered = true; }
    else if (ws && ws.readyState === WebSocket.OPEN) { ws.send(line); delivered = true; }
  } catch (e) { state.error = e.message; state.connected = false; }
  if (cmd.type !== 'hello') {
    state.sent += delivered ? 1 : 0;
    state.log.unshift({ line, delivered });
    state.log.length = Math.min(state.log.length, 30);
  }
  emit();
  return delivered;
}
