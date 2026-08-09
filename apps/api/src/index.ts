import cors from '@fastify/cors';
import Fastify from 'fastify';
import { Server } from 'socket.io';
import { MemoryAccountStore } from './accounts/MemoryAccountStore.js';
import { MySqlAccountStore } from './accounts/MySqlAccountStore.js';
import type { AccountStore } from './accounts/store.js';
import { registerAuthRoutes } from './auth/routes.js';
import { migrate } from './db/migrate.js';
import { env, warnAboutDefaults } from './env.js';
import { LobbyGateway } from './lobby/socket.js';
import { MemoryQueue } from './lobby/queue.js';

warnAboutDefaults();

await migrate();

const accounts: AccountStore = env.databaseUrl ? new MySqlAccountStore() : new MemoryAccountStore();

const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

// Auf dem VPS liefert Caddy Client und Backend unter derselben Herkunft aus,
// dann greift CORS gar nicht. Lokal laufen sie auf getrennten Ports und
// brauchen es.
await app.register(cors, { origin: env.corsOrigin, credentials: true });

// Alles unter /api: auf dem VPS reicht dem Reverse-Proxy dann EINE Regel, und
// die HTTP-Routen liegen im selben Namensraum wie der Lobby-Socket-Pfad
// (/api/socket.io). Lokal ändert sich nur die Basis-URL des Clients.
await app.register(
  async (scope) => {
    scope.get('/health', async () => ({ ok: true }));
    registerAuthRoutes(scope, accounts);
  },
  { prefix: '/api' },
);

// socket.io hängt sich an den fertigen HTTP-Server von Fastify. Das geht erst
// nach `ready()` — vorher existiert `app.server` zwar, hat aber noch nicht alle
// Fastify-Handler, und die Reihenfolge der Upgrade-Behandlung wäre offen.
await app.ready();

const io = new Server(app.server, {
  // Muss zeichengenau zum Client passen und unterhalb von /api liegen, damit
  // der Reverse-Proxy auf dem VPS eine einzige Regel dafür braucht.
  path: '/api/socket.io',
  cors: { origin: env.corsOrigin, credentials: true },
});

const lobby = new LobbyGateway(io, new MemoryQueue());
lobby.register();

await app.listen({ port: env.port, host: env.host });
app.log.info(
  `Backend bereit — Spielserver ${env.gameInternalUrl} (öffentlich ${env.gamePublicUrl})`,
);

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} empfangen, fahre herunter …`);
  lobby.stop();
  await io.close();
  await app.close();
  await accounts.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
