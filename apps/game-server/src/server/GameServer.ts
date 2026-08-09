import type {
  ClientToServerEvents,
  GameSocketData,
  PlayerState,
  ServerToClientEvents,
  Vessel,
} from '@subwarfare/shared';
import { PROTOCOL_VERSION, SIM_STEP_SECONDS, clampStep } from '@subwarfare/shared';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { env } from '../env.js';
import { ocean01 } from '../maps/ocean01.js';
import { Bots } from '../sim/Bots.js';
import { World } from '../world/World.js';
import { redeemTicket } from './tickets.js';

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, GameSocketData>;

/** Broadcasts pro Sekunde. Bewusst niedriger als der Simulationstakt. */
const BROADCAST_HZ = 20;

/**
 * Hysterese der Ortung: erfasst wird bei `sensorRange`, verloren erst bei
 * `sensorRange * ORTUNG_HYSTERESE`. Ohne die Spanne würde ein Kontakt, der
 * genau auf der Reichweitengrenze pendelt, im Sekundentakt auftauchen und
 * verschwinden — auf dem Client hieße das Spawn und Despawn im Wechsel.
 */
const ORTUNG_HYSTERESE = 1.05;

/**
 * Der autoritative Spielserver.
 *
 * Er simuliert alle Fahrzeuge mit festem Schritt und verschickt den Zustand.
 * Vom Client nimmt er ausschließlich Absichten entgegen — Zielkoordinate und
 * Telegrafenstufe — und klemmt beide selbst. Positionen, Kurse oder
 * Geschwindigkeiten vom Client werden nirgends übernommen.
 */
export class GameServer {
  private readonly world = new World(ocean01);
  private readonly bots: Bots;

  private http: HttpServer | null = null;
  private io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, GameSocketData> | null = null;

  /** Verbindung je Account — für den Rauswurf bei Doppelanmeldung. */
  private readonly sockets = new Map<string, GameSocket>();

  /**
   * Ortungslage je Beobachter: Account → Menge der Fahrzeug-IDs, die sein
   * Sonar derzeit hält. Server-seitig geführt, weil die Hysterese Gedächtnis
   * braucht — ob ein Kontakt „gehalten" wird, hängt davon ab, ob er schon
   * erfasst war.
   */
  private readonly detected = new Map<string, Set<string>>();

  private tickTimer: NodeJS.Timeout | null = null;
  private accumulator = 0;
  private lastTickAt = 0n;
  private sinceBroadcast = 0;
  private tick = 0;

  constructor() {
    this.bots = new Bots(this.world, env.bots);
  }

  async start(): Promise<void> {
    if (this.http) throw new Error('GameServer läuft bereits.');

    this.http = createServer((request, response) => this.handleHttp(request, response));
    this.io = new Server(this.http, {
      // Fester Pfad, damit er hinter dem Reverse-Proxy eindeutig ist. Client
      // und Server müssen hier zeichengenau übereinstimmen.
      path: '/game/socket.io',
      cors: { origin: env.corsOrigin, credentials: true },
      // Der Zustand ist ohnehin klein; Kompression kostet bei 20 Hz mehr als
      // sie spart.
      perMessageDeflate: false,
    });

    this.io.use((socket, next) => {
      void this.authorize(socket as GameSocket, next);
    });
    this.io.on('connection', (socket) => this.handleConnection(socket as GameSocket));

    await new Promise<void>((resolve) => this.http!.listen(env.port, env.host, resolve));
    console.log(
      `[game-server] hört auf ${env.host}:${env.port} — Karte "${this.world.map.id}", ` +
        `${env.bots} Bots, ${Math.round(1 / SIM_STEP_SECONDS)} Ticks/s, Broadcast ${BROADCAST_HZ} Hz`,
    );

    this.lastTickAt = process.hrtime.bigint();
    this.tickTimer = setInterval(() => this.update(), SIM_STEP_SECONDS * 1000);
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    this.io?.emit('kicked', { code: 'shutdown', message: 'Server fährt herunter.' });
    await this.io?.close();
    this.io = null;

    const http = this.http;
    this.http = null;
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    console.log('[game-server] gestoppt.');
  }

  /** Interner Statusendpunkt für die Warteschlange des Backends. */
  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    if (request.url !== '/status') {
      response.writeHead(404).end();
      return;
    }
    if (request.headers['x-internal-key'] !== env.internalKey) {
      response.writeHead(403).end();
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        mapId: this.world.map.id,
        // Bots zählen nicht als Spieler — sonst wäre der Server sofort „voll".
        players: this.sockets.size,
        capacity: env.maxPlayers,
        // Wer verbunden ist. Die Lobby erkennt daran, dass ein ausgegebenes
        // Ticket eingelöst wurde, und gibt dessen Platzreservierung frei.
        accounts: [...this.sockets.keys()],
      }),
    );
  }

  private async authorize(socket: GameSocket, next: (error?: Error) => void): Promise<void> {
    const result = await redeemTicket(socket.handshake.auth?.['ticket']);
    if (!result.ok) {
      next(new Error(result.reason));
      return;
    }
    if (this.sockets.size >= env.maxPlayers && !this.sockets.has(result.claims.sub)) {
      next(new Error('Server ist voll.'));
      return;
    }

    socket.data.accountId = result.claims.sub;
    socket.data.name = result.claims.name;
    next();
  }

  private handleConnection(socket: GameSocket): void {
    const { accountId, name } = socket.data;

    // Zweite Anmeldung desselben Accounts verdrängt die erste — sonst blieben
    // Karteileichen stehen und würden den Platz blockieren.
    const previous = this.sockets.get(accountId);
    if (previous) {
      previous.emit('kicked', { code: 'duplicate_session', message: 'An anderer Stelle verbunden.' });
      previous.disconnect(true);
      this.world.remove(accountId);
      // Die neue Sitzung beginnt am Spawnpunkt — mit leerer Ortungslage.
      this.detected.delete(accountId);
    }

    this.sockets.set(accountId, socket);
    const vessel = this.world.spawn(accountId, name);
    console.log(`[game-server] ${name} (${accountId}) verbunden — ${this.sockets.size} Spieler.`);

    socket.emit('welcome', {
      protocolVersion: PROTOCOL_VERSION,
      selfId: accountId,
      map: this.world.map,
      tick: this.tick,
    });
    this.sendOwn(socket, vessel);

    socket.on('order:waypoint', (payload) => {
      const own = this.world.get(accountId);
      if (!own || !isFiniteNumber(payload?.x) || !isFiniteNumber(payload?.y)) return;
      const target = this.world.clampToMap(payload.x, payload.y);
      own.orderMoveTo(target.x, target.y);
      this.sendOwn(socket, own);
    });

    socket.on('order:telegraph', (payload) => {
      const own = this.world.get(accountId);
      if (!own || !isFiniteNumber(payload?.step)) return;
      own.setTelegraph(clampStep(payload.step));
      this.sendOwn(socket, own);
    });

    socket.on('disconnect', () => {
      // Nur aufräumen, wenn diese Verbindung noch die aktuelle ist — bei einer
      // Verdrängung hat der Nachfolger den Platz bereits übernommen.
      if (this.sockets.get(accountId) !== socket) return;
      this.sockets.delete(accountId);
      this.detected.delete(accountId);
      this.world.remove(accountId);
      this.notifyLeft(accountId);
      console.log(`[game-server] ${name} getrennt — ${this.sockets.size} Spieler.`);
    });
  }

  private sendOwn(socket: GameSocket, vessel: Vessel): void {
    socket.emit('own', {
      telegraphStep: vessel.telegraphStep,
      waypoint: vessel.waypoint ? { ...vessel.waypoint } : null,
      serial: vessel.serial,
    });
  }

  /**
   * Ein Zeitschritt.
   *
   * Die vergangene Zeit kommt aus `hrtime` statt aus `Date.now()`: Letzteres
   * springt bei Zeitumstellungen und NTP-Korrekturen, und der alte Aufbau
   * driftete zusätzlich, weil `setInterval` nie exakt trifft.
   */
  private update(): void {
    const now = process.hrtime.bigint();
    const elapsed = Number(now - this.lastTickAt) / 1e9;
    this.lastTickAt = now;

    this.accumulator += Math.min(elapsed, 0.25);

    let steps = 0;
    while (this.accumulator >= SIM_STEP_SECONDS && steps < 5) {
      const before = this.ownSignatures();
      this.bots.update();
      this.world.update(SIM_STEP_SECONDS);
      this.accumulator -= SIM_STEP_SECONDS;
      this.tick += 1;
      steps += 1;
      // Ankunft und Wachhund ändern Wegpunkt und Telegraf von selbst — der
      // Besitzer muss das erfahren, sonst zeigt seine Anzeige einen Befehl,
      // den es nicht mehr gibt.
      this.notifyChangedOwners(before);
    }

    this.sinceBroadcast += elapsed;
    if (this.sinceBroadcast >= 1 / BROADCAST_HZ) {
      this.sinceBroadcast = 0;
      this.broadcastState();
    }
  }

  /**
   * Verschickt den Weltzustand — pro Empfänger gefiltert auf das, was dessen
   * Sonar orten kann.
   *
   * Kein gemeinsamer `io.emit`: was ein Client nicht orten darf, darf gar
   * nicht erst in seinem Netzverkehr auftauchen. Die Anzeige zu filtern und
   * trotzdem alles zu senden wäre in einem U-Boot-Spiel ein
   * Aufklärungs-Wallhack frei Haus.
   *
   * `volatile` bleibt: ein verlorener Zustand ist belanglos, der nächste
   * kommt in 50 ms. Warteschlangen aufzubauen wäre hier schädlich.
   */
  private broadcastState(): void {
    // Die Zustandsobjekte einmal bauen, nicht je Empfänger — die gefilterten
    // Listen zeigen dann auf dieselben Objekte.
    const states = new Map<string, PlayerState>();
    for (const vessel of this.world.all()) states.set(vessel.id, vessel.toState());

    for (const [accountId, socket] of this.sockets) {
      const observer = this.world.get(accountId);
      if (!observer) continue;

      const players: PlayerState[] = [];
      for (const id of this.updateDetection(accountId, observer)) {
        const state = states.get(id);
        if (state) players.push(state);
      }
      socket.volatile.emit('state', { tick: this.tick, players });
    }
  }

  /**
   * Schreibt die Ortungslage eines Beobachters fort und liefert sie zurück.
   *
   * Erfassen bei `sensorRange`, halten bis `sensorRange * ORTUNG_HYSTERESE`,
   * das eigene Boot immer. Verglichen wird quadriert — das läuft für jedes
   * Paar aus Beobachter und Fahrzeug in jedem Broadcast.
   *
   * v1 ortet rein über die Distanz. Spätere Einflüsse — Eigengeräusch bei
   * hoher Fahrt, Tauchtiefe, Thermalschichten — gehören HIER hinein, damit
   * Netzverkehr und Sonaranzeige zwangsläufig dieselbe Wahrheit zeigen.
   */
  private updateDetection(accountId: string, observer: Vessel): Set<string> {
    let held = this.detected.get(accountId);
    if (!held) {
      held = new Set();
      this.detected.set(accountId, held);
    }

    const acquire = observer.sensorRange;
    const release = observer.sensorRange * ORTUNG_HYSTERESE;

    for (const vessel of this.world.all()) {
      if (vessel.id === accountId) {
        held.add(vessel.id);
        continue;
      }
      const dx = vessel.x - observer.x;
      const dy = vessel.y - observer.y;
      const squared = dx * dx + dy * dy;
      const limit = held.has(vessel.id) ? release : acquire;
      if (squared <= limit * limit) held.add(vessel.id);
      else held.delete(vessel.id);
    }

    // Verschwundene Fahrzeuge (Abmeldung, Verdrängung) aus der Lage räumen.
    for (const id of held) {
      if (!this.world.get(id)) held.delete(id);
    }

    return held;
  }

  /**
   * Meldet einen Abgang nur denen, die das Fahrzeug gerade orten — alle
   * anderen wussten nichts von ihm, und die Meldung selbst wäre die
   * Information, dass irgendwo jemand aufgegeben hat.
   */
  private notifyLeft(accountId: string): void {
    for (const [observerId, socket] of this.sockets) {
      const held = this.detected.get(observerId);
      if (held?.delete(accountId)) socket.emit('player:left', { id: accountId });
    }
  }

  /** Kurzform des privaten Zustands, um Änderungen zu erkennen. */
  private static ownSignature(vessel: Vessel): string {
    return `${vessel.serial}:${vessel.telegraphStep}:${vessel.waypoint ? 'z' : '-'}`;
  }

  private ownSignatures(): Map<string, string> {
    const map = new Map<string, string>();
    for (const accountId of this.sockets.keys()) {
      const vessel = this.world.get(accountId);
      if (vessel) map.set(accountId, GameServer.ownSignature(vessel));
    }
    return map;
  }

  private notifyChangedOwners(before: Map<string, string>): void {
    for (const [accountId, socket] of this.sockets) {
      const vessel = this.world.get(accountId);
      if (!vessel) continue;
      if (before.get(accountId) !== GameServer.ownSignature(vessel)) this.sendOwn(socket, vessel);
    }
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
