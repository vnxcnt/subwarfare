import type { WeaponId } from '@subwarfare/shared';
import { DEFAULT_SHIP_STATS } from '@subwarfare/shared';
import { loadAmmoStats } from './ammo/store.js';
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
import { registerFleetRoutes } from './fleet/routes.js';
import { MySqlFleetStore } from './fleet/MySqlFleetStore.js';
import { MemoryFleetStore, type FleetStore } from './fleet/store.js';
import { registerStatsRoutes } from './stats/routes.js';
import { registerSocialRoutes } from './social/routes.js';
import { MySqlSocialStore } from './social/MySqlSocialStore.js';
import { MemorySocialStore, type SocialStore } from './social/store.js';
import { registerModRoutes } from './mod/routes.js';
import { registerWerftRoutes } from './werft/routes.js';
import { MySqlWerftStore } from './werft/MySqlWerftStore.js';
import { MemoryWerftStore, type WerftStore } from './werft/store.js';
import { WerftService } from './werft/service.js';
import { migrate } from './db/migrate.js';
import { env, warnAboutDefaults } from './env.js';
import { fetchGameServerStatus } from './gameserver/status.js';
import { LobbyGateway } from './lobby/socket.js';
import { MemoryQueue } from './lobby/queue.js';
import { loadShipStats } from './ships/store.js';

warnAboutDefaults();

await migrate();

// Schiffskatalog EINMAL laden: die Startprüfung unten braucht ihn, und die
// Werft leitet daraus die maxHp je Modell ab (DB-Änderungen greifen wie beim
// Spielserver erst mit Neustart).
const shipStats = await loadShipStats();

// Struktur-Vertrag der Werft prüfen: die Ausrüstungs-Slots leiten sich aus der
// Bewaffnung im CODE-Katalog ab (equipSlotsForArmament) — die ships-Tabelle
// darf ZAHLEN (HP, Speed) abweichen, aber nicht die Bewaffnung, sonst zeigt
// das Menü Slots, die der Spielserver verweigert. Nur warnen, nicht abbrechen:
// der Betrieb ist mit falscher Anzeige lästig, ohne api aber tot.
for (const ship of shipStats) {
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
const fleets: FleetStore = env.databaseUrl ? new MySqlFleetStore() : new MemoryFleetStore(accounts);
const social: SocialStore = env.databaseUrl ? new MySqlSocialStore() : new MemorySocialStore();
const werftStore: WerftStore = env.databaseUrl ? new MySqlWerftStore() : new MemoryWerftStore();
const werft = new WerftService(werftStore, accounts, shipStats);

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
    registerFleetRoutes(scope, accounts, fleets);
    registerStatsRoutes(scope, accounts);
    // Die Hooks greifen auf `lobby` zu, das erst NACH app.ready() entsteht —
    // die Pfeile binden spät (zur Anfragezeit), genau wie sortie-end unten.
    registerSocialRoutes(scope, accounts, fleets, social, {
      online: (id) => lobby.isOnline(id),
      notify: (id) => lobby.notifySocial(id),
    });
    registerWerftRoutes(scope, accounts, inventory, werft);
    registerModRoutes(scope, accounts, inventory, fleets, werft, social, {
      purgeChat: (id) => lobby.broadcastChatPurge(id),
    });

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

    // Munitionswerte (Schaden je Sorte) — ebenfalls interner Kanal.
    scope.get('/internal/weapons', async (request, reply) => {
      if (request.headers['x-internal-key'] !== env.internalKey) {
        return reply.code(403).send({ error: 'Kein Zugriff.' });
      }
      return { ammo: await loadAmmoStats() };
    });

    /*
     * Einsatzende: der Spielserver meldet, was ein Konto NICHT verschossen hat,
     * und bekommt es gutgeschrieben.
     *
     * Die Gegenrichtung des Lieferscheins im Ticket. Der Schlüssel ist die
     * ganze Absicherung — ein Client könnte sich hierüber sonst Munition
     * herbeischreiben. Deshalb steht die Route auch nicht in der öffentlichen
     * Oberfläche: sie ist ausschließlich für den Spielserver da.
     */
    scope.post('/internal/sortie-end', async (request, reply) => {
      if (request.headers['x-internal-key'] !== env.internalKey) {
        return reply.code(403).send({ error: 'Kein Zugriff.' });
      }
      const body = (request.body ?? {}) as {
        accountId?: unknown;
        leftovers?: unknown;
        coins?: unknown;
      };
      if (typeof body.accountId !== 'string' || !Array.isArray(body.leftovers)) {
        return reply.code(400).send({ error: 'accountId und leftovers erwartet.' });
      }
      const leftovers = body.leftovers.filter(
        (eintrag): eintrag is { weapon: WeaponId; itemId: string; count: number } =>
          typeof eintrag === 'object' &&
          eintrag !== null &&
          typeof (eintrag as { itemId?: unknown }).itemId === 'string' &&
          typeof (eintrag as { count?: unknown }).count === 'number' &&
          (eintrag as { count: number }).count > 0,
      );
      lobby.returnAmmo(body.accountId, leftovers);

      // Extrahierter Loot in Coins. Der Betrag kommt vom Spielserver und nur
      // von dort — der interne Schlüssel ist die ganze Absicherung. Gedeckelt
      // und gerundet, damit ein Rechenfehler drüben nie Unsinn verbucht.
      const coins = typeof body.coins === 'number' && Number.isFinite(body.coins)
        ? Math.min(Math.max(Math.floor(body.coins), 0), 1_000_000)
        : 0;
      if (coins > 0) {
        await accounts.addCoins(body.accountId, coins).catch((error) => {
          console.error(`[api] Loot-Gutschrift an ${body.accountId} fehlgeschlagen:`, error);
        });
      }
      return { ok: true };
    });

    /*
     * Kartenauslastung fürs Hauptmenü — je Karte ein eigener Spielserver, also
     * je Karte eine eigene Abfrage. Kurz gecacht UND mit geteiltem
     * In-flight-Promise: läuft die Abfrage gerade (bis zu 2 s bei hängendem
     * Spielserver), hängen sich weitere Anfragen an dieselbe — sonst würde
     * genau im Störfall jede Menü-Anfrage einen eigenen Upstream-Fetch starten.
     *
     * Beides liegt JE KARTE vor: ein globaler Cache würde eine langsame Karte
     * mit einer schnellen verrechnen, und ein globales Promise ließe die Anfrage
     * für ocean01 auf den hängenden ocean04-Server warten. Auch das Fehlschlagen
     * wird gecacht (Eintrag `null`) — ein toter Spielserver soll nicht bei jeder
     * Menü-Anfrage erneut ins Zeitlimit laufen.
     */
    const mapsCache = new Map<string, { at: number; entry: MapStatusEntry | null }>();
    const mapsInFlight = new Map<string, Promise<MapStatusEntry | null>>();
    const mapStatus = (mapId: string): Promise<MapStatusEntry | null> | MapStatusEntry | null => {
      const cached = mapsCache.get(mapId);
      if (cached && Date.now() - cached.at < 3_000) return cached.entry;

      const laufend = mapsInFlight.get(mapId);
      if (laufend) return laufend;

      const abfrage = (async () => {
        try {
          const status = await fetchGameServerStatus(mapId);
          // Die Kennung aus der Tabelle, nicht die gemeldete: der Client wählt
          // seine Karte über genau diesen Schlüssel. (Meldet der Spielserver
          // eine andere, liefert fetchGameServerStatus ohnehin null.)
          const entry: MapStatusEntry | null = status
            ? { mapId, players: status.players, capacity: status.capacity }
            : null;
          mapsCache.set(mapId, { at: Date.now(), entry });
          return entry;
        } finally {
          mapsInFlight.delete(mapId);
        }
      })();
      mapsInFlight.set(mapId, abfrage);
      return abfrage;
    };

    scope.get('/maps/status', async (): Promise<MapsStatusPayload> => {
      // Alle Karten parallel: die Anzeige soll so lange brauchen wie die
      // langsamste, nicht wie ihre Summe.
      const eintraege = await Promise.all([...env.gameMaps.keys()].map((id) => mapStatus(id)));
      return { maps: eintraege.filter((eintrag): eintrag is MapStatusEntry => eintrag !== null) };
    });
  },
  { prefix: '/api' },
);

/** Auslastung EINER Karte. Fehlt sie in der Antwort, ist ihr Server stumm. */
interface MapStatusEntry {
  mapId: string;
  players: number;
  capacity: number;
}

interface MapsStatusPayload {
  maps: MapStatusEntry[];
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

const lobby = new LobbyGateway(io, new MemoryQueue(), accounts, inventory, fleets, social, werft);
lobby.register();

await app.listen({ port: env.port, host: env.host });
const karten = [...env.gameMaps]
  .map(([mapId, ziel]) => `${mapId} → ${ziel.internalUrl} (öffentlich ${ziel.publicUrl || '—'})`)
  .join(', ');
app.log.info(`Backend bereit — Spielserver: ${karten}`);

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
