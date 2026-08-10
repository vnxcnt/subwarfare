/** Schub-Diagnose: Telegraf setzen, Fahrt über die Zeit beobachten. */
import { createHmac } from 'node:crypto';
import { io } from 'socket.io-client';

const b64 = (v) => Buffer.from(v).toString('base64url');
function ticket(sub, name) {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({
    sub, name, mapId: 'ocean01', role: 0, aud: 'subwarfare:game',
    jti: `s${Date.now()}-${sub}`, exp: Math.floor(Date.now() / 1000) + 300,
  }));
  const sig = createHmac('sha256', 'dev-secret-change-me').update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const s = io('http://127.0.0.1:8080', { path: '/game/socket.io', auth: { ticket: ticket('schub-1', 'Schubtest') }, transports: ['websocket'], reconnection: false });
let state = null, self = null, own = null;
s.on('welcome', (w) => { self = w.selfId; });
s.on('state', (st) => { state = st; });
s.on('own', (o) => { own = o; });
s.on('connect_error', (e) => { console.log('Fehler:', e.message); process.exit(1); });
await wait(1000);

const me = () => state?.players.find((p) => p.id === self);
console.log('Start:', JSON.stringify(me()), '| own.telegraphStep =', own?.telegraphStep);

console.log('\n=== Telegraf 8 (Äußerste Kraft) ===');
s.emit('order:telegraph', { step: 8 });
for (let t = 1; t <= 6; t += 1) {
  await wait(1000);
  const m = me();
  console.log(`t=${t}s  speed=${m.speed.toFixed(1)} m/s  pos=(${m.x.toFixed(0)}, ${m.y.toFixed(0)})  step=${own?.telegraphStep}`);
}

console.log('\n=== Telegraf 4 (Kleine Fahrt) ===');
s.emit('order:telegraph', { step: 4 });
await wait(3000);
console.log(`speed=${me().speed.toFixed(1)} m/s  step=${own?.telegraphStep}`);

console.log('\n=== W-Taste-Pfad: nudge von 4 auf 5 ===');
s.emit('order:telegraph', { step: 5 });
await wait(2000);
console.log(`speed=${me().speed.toFixed(1)} m/s  step=${own?.telegraphStep}`);

s.disconnect();
process.exit(0);
