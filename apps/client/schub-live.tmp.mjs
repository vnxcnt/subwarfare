/** Schub-Diagnose gegen den LIVE-Server (Ticket mit Live-Secret). */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { io } from 'socket.io-client';

const SECRET = readFileSync(process.env.TEMP + '\\live-secret.txt', 'utf8').trim().split('=')[1];
const b64 = (v) => Buffer.from(v).toString('base64url');
function ticket(sub, name) {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({
    sub, name, mapId: 'ocean01', role: 0, aud: 'subwarfare:game',
    jti: `L${Date.now()}-${sub}`, exp: Math.floor(Date.now() / 1000) + 300,
  }));
  const sig = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const s = io('http://178.105.222.182', { path: '/game/socket.io', auth: { ticket: ticket('live-schubtest', 'Schubtest') }, transports: ['websocket'], reconnection: false });
let state = null, self = null, own = null;
s.on('welcome', (w) => { self = w.selfId; console.log('verbunden, Protokoll', w.protocolVersion); });
s.on('state', (st) => { state = st; });
s.on('own', (o) => { own = o; });
s.on('connect_error', (e) => { console.log('Fehler:', e.message); process.exit(1); });
await wait(1500);

const me = () => state?.players.find((p) => p.id === self);
console.log('Start:', JSON.stringify(me()));

s.emit('order:telegraph', { step: 8 });
for (let t = 1; t <= 5; t += 1) {
  await wait(1000);
  const m = me();
  console.log(`t=${t}s  speed=${m?.speed?.toFixed(1)} m/s  pos=(${m?.x?.toFixed(0)}, ${m?.y?.toFixed(0)})  step=${own?.telegraphStep}`);
}

s.disconnect();
process.exit(0);
