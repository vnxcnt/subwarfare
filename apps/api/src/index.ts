import { DEFAULT_SHIP_STATS } from '@subwarfare/shared';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { Server } from 'socket.io';
import { MemoryAccountStore } from './accounts/MemoryAccountStore.js';
import { loadArmorStats } from './armor/store.js';
import { MySqlAccountStore } from './accounts/MySqlAccountStore.js';
import type { AccountStore } from './accounts/store.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerEconomyRoutes } from './economy/routes.js';
import { MySqlInventoryStore } from './economy/MySqlInventoryStore.js';
import { MemoryInventoryStore, type InventoryStore } from './economy/store.js';
import { migrate } from './db/migrate.js';
import { env, warnAboutDefaults } from './env.js';
import { fetchGameServerStatus } from './gameserver/status.js';
import { LobbyGateway } from './lobby/socket.js';
import { MemoryQueue } from './lobby/queue.js';
import { loadShipStats } from './ships/store.js';

warnAboutDefaults();

await migrate();

// Struktur-Vertrag der Werft prüfen: die Ausrüstungs-Slots leiten sich aus der
// Bewaffnung im CODE-Katalog ab (equipSlotsForArmament) — die ships-Tabelle
// darf ZAHLEN (HP, Speed) abweichen, aber nicht die Bewaffnung, sonst zeigt
// das Menü Slots, die der Spielserver verweigert. Nur warnen, nicht abbrechen:
// der Betrieb ist mit falscher Anzeige lästig, ohne api aber tot.
for (const ship of await loadShipStats()) {
  const expected = [...(DEFAULT_SHIP_STATS[ship.model]?.armament ?? [])].sort().join(',');
  const actual = [...ship.armament].sort().join(',');
  if (expected !== actual) {
    console.warn(
      `[api] ships.${ship.model}: Bewaffnung in der DB (${actual || '—'}) weicht vom ` +
        `Code-Katalog (${expected || '—'}) ab — die Ausrüstungs-Slots folgen dem Code.`,
    );
  }
}

const accounts: AccountStore = env.databaseUrl ? new MySqlAccountStore() : new MemoryAccountStore();
const inventory: InventoryStore = env.databaseUrl
  ? new MySqlInventoryStore()
  : new MemoryInventoryStore(accounts);

const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

// Auf dem VPS liefert Caddy Client und Backend unter derselben Herkunft aus,
// dann greift CORS gar nicht. Lokal laufen sie auf getrennten Ports und
// brauchen es. DELETE muss EXPLIZIT erlaubt werden — der Plugin-Default
// deckt nur GET/HEAD/POST, und der Preflight der Konto-Löschung scheiterte
// lokal genau daran.
await app.register(cors, {
  origin: env.corsOrigin,
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'DELETE'],
});

// Alles unter /api: auf dem VPS reicht dem Reverse-Proxy dann EINE Regel, und
// die HTTP-Routen liegen im selben Namensraum wie der Lobby-Socket-Pfad
// (/api/socket.io). Lokal ändert sich nur die Basis-URL des Clients.
await app.register(
  async (scope) => {
    scope.get('/health', async () => ({ ok: true }));
    registerAuthRoutes(scope, accounts, inventory);
    registerEconomyRoutes(scope, accounts, inventory);

    // Interner Kanal für den Spielserver — derselbe Schlüssel wie dessen
    // /status. Von außen kommt man über Caddy zwar an die URL, aber ohne
    // Schlüssel gibt es nur 403 (und geheim ist am Schiffskatalog nichts).
    scope.get('/internal/ships', async (request, reply) => {
      if (request.headers['x-internal-key'] !== env.internalKey) {
        return reply.code(403).send({ error: 'Kein Zugriff.' });
      }
      return { ships: await loadShipStats() };
    });

    // Panzerungswerte, gleicher Kanal und gleiche Regeln wie der Schiffskatalog.
    scope.get('/internal/armor', async (request, reply) => {
      if (request.headers['x-internal-key'] !== env.internalKey) {
        return reply.code(403).send({ error: 'Kein Zugriff.' });
      }
      return { armor: await loadArmorStats() };
    });

    // Kartenauslastung fürs Hauptmenü. Kurz gecacht UND mit geteiltem
    // In-flight-Promise: läuft die Abfrage gerade (bis zu 2 s bei hängendem
    // Spielserver), hängen sich weitere Anfragen an dieselbe — sonst würde
    // genau im Störfall jede Menü-Anfrage einen eigenen Upstream-Fetch starten.
    let mapsCache: { at: number; payload: MapsStatusPayload } | null = null;
    let mapsInFlight: Promise<MapsStatusPayload> | null = null;
    scope.get('/maps/status', (): Promise<MapsStatusPayload> | MapsStatusPayload => {
      if (mapsCache && Date.now() - mapsCache.at < 3_000) return mapsCache.payload;
      mapsInFlight ??= (async () => {
        try {
          const status = await fetchGameServerStatus();
          const payload: MapsStatusPayload = {
            maps: status
              ? [{ mapId: status.mapId, players: status.players, capacity: status.capacity }]
              : [],
          };
          mapsCache = { at: Date.now(), payload };
          return payload;
        } finally {
          mapsInFlight = null;
        }
      })();
      return mapsInFlight;
    });
  },
  { prefix: '/api' },
);

interface MapsStatusPayload {
  maps: Array<{ mapId: string; players: number; capacity: number }>;
}

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

const lobby = new LobbyGateway(io, new MemoryQueue(), accounts, inventory);
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
