import type {
  ClientToServerEvents,
  GameSocketData,
  PlayerState,
  ServerToClientEvents,
  Vessel,
  VesselModel,
} from '@subwarfare/shared';
import {
  DAMAGE,
  DECOY,
  DEPTH_CHARGE,
  EXTRACTION_SECONDS,
  GUN,
  LOOT_PICKUP_RADIUS,
  NPC_LOOT,
  PROTOCOL_VERSION,
  RESPAWN_SECONDS,
  ROLE_DEVELOPER,
  SECTOR_TOLERANCE_DEG,
  SHIP_ACCESS,
  SHIP_TYPE_SUBMARINE,
  SIDE_LAUNCH_HALF_ANGLE_DEG,
  SIM_STEP_SECONDS,
  TORPEDO,
  angleDelta,
  clampStep,
  currentHour,
  effectiveSensorRange,
  isPlayableModel,
  isVesselModel,
  sanitizeWeather,
} from '@subwarfare/shared';
import type {
  LoadoutEntryStack,
  TubePosition,
  TubeState,
  WeaponId,
  WeatherState,
} from '@subwarfare/shared';
import { TUBE, tubeBearing, tubeLayoutFor } from '@subwarfare/shared';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';

/** Ein Rohr auf dem Server — wie `TubeState`, nur mit der Restzeit in Sekunden. */
interface Tube {
  position: TubePosition;
  status: 'leer' | 'laedt' | 'geladen';
  /** Restliche Ladezeit in Sekunden; 0, sobald geladen. */
  remaining: number;
  armed: boolean;
}
import { Server, type Socket } from 'socket.io';
import { env } from '../env.js';
import { ocean01, ocean01Weather } from '../maps/ocean01.js';
import { AmmoCatalog } from '../sim/AmmoCatalog.js';
import { ArmorCatalog } from '../sim/ArmorCatalog.js';
import { Bots } from '../sim/Bots.js';
import { ShipCatalog } from '../sim/ShipCatalog.js';
import { World, type WorldEvents } from '../world/World.js';
import { consumeTicket, redeemedTickets, verifyTicket } from './tickets.js';

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
  private readonly ships = new ShipCatalog();
  private readonly armor = new ArmorCatalog();
  private readonly ammoCatalog = new AmmoCatalog();
  private readonly world = new World(ocean01, this.ships);
  /**
   * Wetterlage dieser Karte — Quelle für Seegang-Wirkung und Client-Optik.
   * Nicht `readonly`: das Entwicklermenü kann sie zur Laufzeit setzen.
   */
  private weather: WeatherState = ocean01Weather;
  /**
   * Wann die aktuelle Wetterlage gesetzt wurde (hrtime-Sekunden).
   *
   * Nötig, sobald die Tag/Nacht-Uhr läuft: `weather.timeOfDay` ist die
   * AUSGANGSZEIT, die Uhr läuft client-seitig weiter. Ohne diese Zeitbasis
   * bekäme ein später Beitretender die eingefrorene Ausgangszeit und stünde
   * dauerhaft in einer anderen Tageszeit als alle anderen — bei einem
   * 10-Minuten-Tag schnell ein halber Tag Versatz.
   */
  private weatherSetAt = process.hrtime.bigint();
  private bots: Bots | null = null;

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

  /**
   * Restmunition je Account und Waffe — angelegt beim Beitritt aus dem Ticket.
   *
   * `Partial`, und das ist der Kern der neuen Regel: ein FEHLENDER Schlüssel
   * heißt „diese Waffe ist nicht an Bord". Das ist etwas anderes als 0
   * („dabei, aber verschossen") und geht genau so an den Client.
   */
  private readonly ammo = new Map<string, Partial<Record<WeaponId, number>>>();
  /** Rohr-Sperren je Waffe: frühester Tick, ab dem wieder gefeuert werden darf. */
  private readonly nextFireTick = new Map<
    string,
    { torpedo: number; taeuschkoerper: number; geschuetz: number; wasserbombe: number }
  >();
  /**
   * Torpedorohre je Account, in Anzeige-Reihenfolge. Der Ladezustand ist
   * SPIELSTAND, kein Anzeigewert: geladen wird von Hand, geschossen wird als
   * Salve aus allen scharf geschalteten Rohren.
   */
  private readonly tubes = new Map<string, Tube[]>();
  /** Versenkte Spieler, die auf ihren Wiedereinstieg warten. */
  private readonly pendingRespawns = new Map<string, { seconds: number; model: VesselModel }>();
  /**
   * Getragener Loot je Account in Coins. FRACHT, kein Besitz: gutgeschrieben
   * wird erst bei der Extraktion, beim Untergang geht alles wieder über Bord.
   */
  private readonly loot = new Map<string, number>();
  /**
   * Wessen Einsatzgebühr schon als Kiste gefallen ist. Die Gebühr wurde EINMAL
   * bezahlt und fällt deshalb nur beim ersten Untergang — sonst wäre ein
   * absichtlich mehrfach versenktes Schiff eine Coin-Druckmaschine für den
   * Gegner (bezahlt 375, gedroppt 3 × 375).
   */
  private readonly feeDropped = new Set<string>();
  /** Sekunden ununterbrochen in einer Extraktionszone, je Account. */
  private readonly extractionSeconds = new Map<string, number>();
  /** Accounts, deren Extraktion gerade abgeschlossen wird (Trennung läuft). */
  private readonly extracting = new Set<string>();

  private tickTimer: NodeJS.Timeout | null = null;
  private accumulator = 0;
  private lastTickAt = 0n;
  private sinceBroadcast = 0;
  private tick = 0;

  async start(): Promise<void> {
    if (this.http) throw new Error('GameServer läuft bereits.');

    // Kataloge VOR dem ersten Spawn — die Bots fahren bereits damit.
    // Nebenläufig: beide warten im schlechtesten Fall ~10 s auf die api,
    // nacheinander wäre das die doppelte Startverzögerung für dieselbe Ursache.
    await Promise.all([this.ships.load(), this.armor.load(), this.ammoCatalog.load()]);
    // Seegang in die Welt: er streut jeden Schuss von rollendem Deck.
    this.world.setSeaState(this.weather.seaState);
    this.bots = new Bots(this.world, env.bots);

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

    // Ein Neustart beendet alle laufenden Einsätze — das ist NICHT die Schuld
    // der Spieler, also volle Abrechnung wie bei einer Extraktion: Munition
    // zurück und getragenen Loot gutschreiben. Fire-and-forget; die Meldungen
    // laufen los, bevor die Verbindungen fallen.
    for (const [accountId, socket] of this.sockets) {
      if (this.extracting.has(accountId)) continue;
      this.reportSortieEnd(accountId, socket.data.loadout, this.loot.get(accountId) ?? 0);
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
        // Wer verbunden ist — daran sieht die Lobby, wer gerade Platz belegt.
        accounts: [...this.sockets.keys()],
        // Welche Tickets verbraucht sind. Nötig, weil `accounts` nur die
        // AKTUELL Verbundenen zeigt: wer beitritt und gleich wieder geht,
        // verschwindet daraus, sein Ticket bleibt aber verbrannt.
        redeemed: redeemedTickets(),
      }),
    );
  }

  private async authorize(socket: GameSocket, next: (error?: Error) => void): Promise<void> {
    const result = await verifyTicket(socket.handshake.auth?.['ticket']);
    if (!result.ok) {
      next(new Error(result.reason));
      return;
    }
    // Kapazität VOR dem Verbrauch der jti prüfen: die Einsatzkosten sind bei
    // Ticketausgabe bereits bezahlt — ein an der Kapazität gescheiterter
    // Versuch muss das Ticket gültig lassen, sonst wäre jeder Voll-Reject
    // verbranntes Guthaben.
    if (this.sockets.size >= env.maxPlayers && !this.sockets.has(result.claims.sub)) {
      next(new Error('Server ist voll.'));
      return;
    }
    if (!consumeTicket(result.claims.jti, result.expiresAt)) {
      next(new Error('Ticket wurde bereits eingelöst.'));
      return;
    }

    socket.data.accountId = result.claims.sub;
    socket.data.name = result.claims.name;
    socket.data.role = result.claims.role;
    socket.data.shipModel = result.claims.shipModel;
    socket.data.armorItem = result.claims.armorItem;
    socket.data.loadout = result.claims.loadout;
    next();
  }

  private handleConnection(socket: GameSocket): void {
    const { accountId, name } = socket.data;

    // Zweite Anmeldung desselben Accounts verdrängt die erste — sonst blieben
    // Karteileichen stehen und würden den Platz blockieren.
    const previous = this.sockets.get(accountId);
    if (previous) {
      // Der alte Einsatz endet ohne Extraktion — sein Loot und seine
      // Restmunition verfallen, wie bei jedem anderen Abgang auch. Das neue
      // Ticket bringt seine eigene Ausrüstung mit.
      previous.emit('kicked', { code: 'duplicate_session', message: 'An anderer Stelle verbunden.' });
      previous.disconnect(true);
      this.world.remove(accountId);
      // Die neue Sitzung beginnt am Spawnpunkt — mit leerer Ortungslage und
      // frischer Einsatzbuchhaltung.
      this.detected.delete(accountId);
      this.loot.delete(accountId);
      this.feeDropped.delete(accountId);
      this.extractionSeconds.delete(accountId);
      this.extracting.delete(accountId);
    }

    // Auch eine noch laufende Respawn-Wartezeit verfällt — die neue Sitzung
    // beginnt frisch am Spawnpunkt.
    this.pendingRespawns.delete(accountId);

    this.sockets.set(accountId, socket);
    // Das Modell kommt aus dem signierten Ticket — Level und Einsatzkosten hat
    // die api dort schon geprüft. Die isVesselModel-Prüfung ist das Sicherheits-
    // netz gegen ein älteres Backend oder eine Kennung ohne Client-Atlas.
    const ticketModel = socket.data.shipModel;
    const vessel = this.world.spawn(
      accountId,
      name,
      isVesselModel(ticketModel) ? ticketModel : undefined,
      // Panzerung ebenfalls aus dem signierten Ticket. Eine unbekannte Kennung
      // löst der Katalog zu null auf — dann fährt das Boot ungepanzert.
      this.armor.get(socket.data.armorItem),
    );
    this.loadAmmoFromTicket(socket);
    this.resetTubes(accountId, vessel.model);
    console.log(`[game-server] ${name} (${accountId}) verbunden — ${this.sockets.size} Spieler.`);

    socket.emit('welcome', {
      protocolVersion: PROTOCOL_VERSION,
      selfId: accountId,
      map: this.world.map,
      ships: this.ships.all(),
      // Fortgeschriebene Tageszeit statt der Ausgangszeit — sonst begänne der
      // Tag für jeden Beitretenden von vorn.
      weather: this.currentWeather(),
      tick: this.tick,
    });
    this.sendOwn(socket, vessel);

    socket.on('order:steer', (payload) => {
      const own = this.world.get(accountId);
      if (!own || !isFiniteNumber(payload?.value)) return;
      // setSteer klemmt selbst auf −1..1. Kein sendOwn nötig — die Ruderlage
      // ist keine Anzeige, ihr Ergebnis (der Kurs) läuft im Broadcast mit.
      own.setSteer(payload.value);
    });

    socket.on('order:telegraph', (payload) => {
      const own = this.world.get(accountId);
      if (!own || !isFiniteNumber(payload?.step)) return;
      own.setTelegraph(clampStep(payload.step));
      this.sendOwn(socket, own);
    });

    socket.on('order:dive', (payload) => {
      const own = this.world.get(accountId);
      if (!own) return;
      // Tauchen können nur Schiffe vom Typ Submarine — der Katalog entscheidet,
      // nicht der Client. Alles andere wird kommentarlos verworfen.
      if (this.ships.get(own.model).type !== SHIP_TYPE_SUBMARINE) return;
      const submerged = payload?.submerged === true;
      // Schwer beschädigt (unter der Auftauch-Schwelle) bleibt das Boot oben:
      // Abtauchen wird verworfen, Auftauchen geht immer.
      if (
        submerged &&
        this.world.hp(accountId) < this.ships.get(own.model).hp * DAMAGE.surfaceHpRatio
      ) {
        return;
      }
      own.orderDive(submerged);
      this.sendOwn(socket, own);
    });

    socket.on('order:periscope', (payload) => {
      const own = this.world.get(accountId);
      if (!own) return;
      // Wie das Tauchen: nur U-Boote, der Katalog entscheidet.
      if (this.ships.get(own.model).type !== SHIP_TYPE_SUBMARINE) return;
      own.orderPeriscope(payload?.extended === true);
      this.sendOwn(socket, own);
    });

    socket.on('order:fire', (payload) => {
      const own = this.world.get(accountId);
      // Versenkt oder nicht gespawnt — keine Waffe ohne Schiff.
      if (!own) return;
      // Feuerbare Waffen: Torpedo, Täuschkörper, Geschütz, Wasserbombe.
      const weapon = payload?.weapon;
      if (
        weapon !== 'torpedo' &&
        weapon !== 'taeuschkoerper' &&
        weapon !== 'geschuetz' &&
        weapon !== 'wasserbombe'
      ) {
        return;
      }
      // Ob das Schiff die Waffe überhaupt führt, sagt der Katalog — nicht
      // der Client. Ein gebasteltes Ereignis wird kommentarlos verworfen.
      const stats = this.ships.get(own.model);
      if (!stats.armament.includes(weapon)) return;

      // Der Torpedo läuft über die ROHRE: gefeuert wird, was scharf und
      // geladen ist — der Vorrat wurde schon beim Laden verbraucht.
      if (weapon === 'torpedo') {
        this.fireSalvo(socket, own, payload?.bearingDegrees);
        return;
      }

      const ammo = this.ammo.get(accountId);
      // Fehlender Schlüssel = Waffe nicht an Bord, 0 = verschossen. Beides
      // führt hier zum selben Ergebnis: es fällt kein Schuss.
      const vorrat = ammo?.[weapon] ?? 0;
      if (!ammo || vorrat <= 0) return;
      // Rohr-Sperre je Waffe in Server-Ticks — der Knopf im Client ist Höflichkeit.
      const gates =
        this.nextFireTick.get(accountId) ??
        { torpedo: 0, taeuschkoerper: 0, geschuetz: 0, wasserbombe: 0 };
      if (this.tick < gates[weapon]) return;

      const isSubmarine = stats.type === SHIP_TYPE_SUBMARINE;

      if (isSubmarine) {
        // U-Boote zielen nicht: Täuschkörper achtern. Geschütz und
        // Wasserbombe führt kein U-Boot (der Katalog fängt das schon, die
        // Prüfung hier ist das zweite Netz); der Torpedo ist oben abgebogen.
        if (weapon !== 'taeuschkoerper') return;
        this.world.fireDecoy(own);
      } else {
        // Überwasserschiffe feuern SEKTORGEBUNDEN auf die gezielte Peilung:
        // Geschütz im Bugsektor, Torpedo/Täuschkörper über die Seiten.
        // Außerhalb fällt kein Schuss — verwerfen, nicht klemmen: der Client
        // zeigt den ungültigen Winkel als rote Ziellinie.
        const bearing = payload?.bearingDegrees;
        if (!isFiniteNumber(bearing)) return;
        // Mit Toleranz: der Client zielt mit der Render-Rotation (~125 ms
        // Verzug) — am Sektorrand wäre die grüne Linie sonst eine Lüge.
        const offset = angleDelta(own.rotation, bearing);
        if (weapon === 'geschuetz') {
          if (Math.abs(offset) > GUN.arcHalfAngleDeg + SECTOR_TOLERANCE_DEG) return;
          this.world.fireShell(own, bearing);
        } else if (weapon === 'wasserbombe') {
          // Sektor um ACHTERAUS: |offset| misst vom Bug, 180 ist dead astern.
          if (
            180 - Math.abs(offset) >
            DEPTH_CHARGE.arcHalfAngleDeg + SECTOR_TOLERANCE_DEG
          ) {
            return;
          }
          this.world.fireDepthCharge(own, bearing);
        } else {
          if (Math.abs(Math.abs(offset) - 90) > SIDE_LAUNCH_HALF_ANGLE_DEG + SECTOR_TOLERANCE_DEG) {
            return;
          }
          this.world.fireDecoySide(own, bearing);
        }
      }

      const spec =
        weapon === 'taeuschkoerper'
          ? DECOY
          : weapon === 'wasserbombe'
            ? DEPTH_CHARGE
            : GUN;
      ammo[weapon] = vorrat - 1;
      gates[weapon] = this.tick + Math.round(spec.cooldownSeconds / SIM_STEP_SECONDS);
      this.nextFireTick.set(accountId, gates);
      // Munitionsstand sofort bestätigen, nicht erst mit dem nächsten Tick.
      this.sendOwn(socket, own);
    });

    socket.on('order:tube', (payload) => {
      this.handleTubeOrder(socket, accountId, payload);
    });

    socket.on('dev:weather', (payload) => {
      // Wie bei dev:model: Rolle aus dem TICKET, nicht aus dem Ereignis.
      if (socket.data.role < ROLE_DEVELOPER) return;
      const weather = sanitizeWeather(payload);
      if (!weather) return;

      this.weather = weather;
      this.weatherSetAt = process.hrtime.bigint();
      // Der Seegang wirkt server-seitig auf die Schussstreuung — ohne diese
      // Zeile wäre die Änderung reine Optik.
      this.world.setSeaState(weather.seaState);
      // An ALLE: Wetter ist Weltzustand, nicht Ansichtssache. Sonst sähen zwei
      // Spieler verschiedene Seen, während beide dieselbe Streuung abbekommen.
      for (const other of this.sockets.values()) other.emit('weather', weather);
      console.log(
        `[game-server] ${name} setzt Wetter: Seegang ${weather.seaState.toFixed(2)}, ` +
          `${weather.timeOfDay.toFixed(1)} h, Wolken ${weather.cloudCover.toFixed(2)}.`,
      );
    });

    socket.on('dev:crate', (payload) => {
      // Testkiste für die Beuteschleife — Rolle aus dem TICKET, Werte geklemmt.
      if (socket.data.role < ROLE_DEVELOPER) return;
      const own = this.world.get(accountId);
      if (!own || !isFiniteNumber(payload?.coins)) return;
      const coins = Math.min(Math.max(Math.floor(payload.coins), 1), 10_000);
      // 120 m voraus: außerhalb des Aufsammelradius, damit man das Überfahren
      // wirklich sieht, statt die Kiste im Entstehen zu schlucken.
      const heading = own.rotation * (Math.PI / 180);
      this.world.spawnCrate(
        own.x + Math.sin(heading) * 120,
        own.y - Math.cos(heading) * 120,
        coins,
      );
      console.log(`[game-server] ${name} setzt Testkiste (${coins} Coins).`);
    });

    socket.on('dev:model', (payload) => {
      // Rolle UND Modell prüfen — der Knopf im Client ist Höflichkeit, die
      // Wahrheit sitzt hier. Ein gebasteltes Ereignis ohne Entwicklerrolle
      // wird kommentarlos verworfen.
      if (socket.data.role < ROLE_DEVELOPER) return;
      if (!isVesselModel(payload?.model)) return;
      const own = this.world.get(accountId);
      if (!own) return;
      own.model = payload.model;
      // Mit dem Modell wechselt auch die Fahrleistung (speed-Faktor der
      // ships-Tabelle) — ab dem naechsten Simulationsschritt.
      own.applyProfile(this.ships.profile(payload.model));
      // Ein Modellwechsel ist ein frisches Schiff: volle Lebenspunkte des
      // neuen Modells, Munition wieder auf den Stand des Tickets. Reines
      // Entwickler-Werkzeug — und keine Item-Quelle: die Rückgabe am Ende
      // deckelt auf die mitgenommene Stückzahl, mehr kann nicht zurückfließen.
      this.world.resetHp(accountId);
      this.loadAmmoFromTicket(socket);
      // Anderes Modell heißt andere Rohrbestückung.
      this.resetTubes(accountId, payload.model);
      // Wer vom U-Boot auf ein Überwasserschiff wechselt, taucht zwangsläufig
      // auf und fährt das Periskop ein — beides über die normalen Wege.
      if (this.ships.get(payload.model).type !== SHIP_TYPE_SUBMARINE) {
        own.orderDive(false);
        own.orderPeriscope(false);
      }
      this.sendOwn(socket, own);
      console.log(`[game-server] ${name} wechselt Modell auf ${payload.model} (Entwickler).`);
    });

    socket.on('disconnect', () => {
      // Nur aufräumen, wenn diese Verbindung noch die aktuelle ist — bei einer
      // Verdrängung hat der Nachfolger den Platz bereits übernommen.
      if (this.sockets.get(accountId) !== socket) return;
      // BEWUSST keine Abrechnung: wer ohne Extraktion geht — Knopf, Absturz,
      // Kabel — verliert Loot und mitgebrachte Ausrüstung. Die Extraktion hat
      // ihre Abrechnung schon selbst gemacht, bevor sie hier ankommt.
      this.sockets.delete(accountId);
      this.loot.delete(accountId);
      this.feeDropped.delete(accountId);
      this.extractionSeconds.delete(accountId);
      this.extracting.delete(accountId);
      this.detected.delete(accountId);
      this.pendingRespawns.delete(accountId);
      this.ammo.delete(accountId);
      this.nextFireTick.delete(accountId);
      this.tubes.delete(accountId);
      this.world.remove(accountId);
      this.notifyLeft(accountId);
      console.log(`[game-server] ${name} getrennt — ${this.sockets.size} Spieler.`);
    });
  }

  /**
   * Rohr-Befehl: laden oder scharf schalten. Index −1 gilt für ALLE Rohre —
   * das ist der „alles laden"/„alles scharf"-Griff aus der Anzeige.
   */
  private handleTubeOrder(socket: GameSocket, accountId: string, payload: unknown): void {
    const tubes = this.tubes.get(accountId);
    if (!tubes || tubes.length === 0) return;
    const order = payload as { index?: unknown; action?: unknown; armed?: unknown } | undefined;
    const action = order?.action;
    if (action !== 'laden' && action !== 'scharf') return;
    if (!isFiniteNumber(order?.index)) return;

    const index = Math.trunc(order.index);
    if (index !== -1 && (index < 0 || index >= tubes.length)) return;
    const betroffen = index === -1 ? tubes : [tubes[index] as Tube];

    let geaendert = false;
    if (action === 'laden') {
      const ammo = this.ammo.get(accountId);
      for (const tube of betroffen) {
        if (tube.status !== 'leer') continue;
        // Der Vorrat wird beim LADEN verbraucht, nicht beim Schuss: ein
        // geladenes Rohr ist bereits bezahlt.
        const vorrat = ammo?.torpedo ?? 0;
        if (!ammo || vorrat <= 0) break;
        ammo.torpedo = vorrat - 1;
        tube.status = 'laedt';
        tube.remaining = TUBE.reloadSeconds;
        geaendert = true;
      }
    } else {
      // Beim Sammelbefehl entscheidet der erste betroffene Zustand, ob
      // scharf gemacht oder entschärft wird — sonst würde „alles scharf"
      // bei gemischtem Zustand die Hälfte wieder ausschalten.
      const ziel =
        typeof order?.armed === 'boolean'
          ? order.armed
          : !betroffen.some((tube) => tube.status === 'geladen' && tube.armed);
      for (const tube of betroffen) {
        // Nur geladene Rohre lassen sich scharf schalten.
        if (tube.status !== 'geladen') continue;
        if (tube.armed === ziel) continue;
        tube.armed = ziel;
        geaendert = true;
      }
    }

    if (geaendert) {
      const own = this.world.get(accountId);
      if (own) this.sendOwn(socket, own);
    }
  }

  /**
   * Torpedo-Salve: alle scharfen, geladenen Rohre feuern gleichzeitig.
   *
   * Rohre schießen in ihre Einbaurichtung. Beim Überwasserschiff zielt der
   * Spieler zusätzlich, und dann feuern nur die Rohre der passenden SEITE —
   * ein Backbordrohr schießt nicht nach Steuerbord.
   */
  private fireSalvo(socket: GameSocket, own: Vessel, bearing: unknown): void {
    const accountId = socket.data.accountId;
    const tubes = this.tubes.get(accountId);
    if (!tubes) return;

    const stats = this.ships.get(own.model);
    const isSubmarine = stats.type === SHIP_TYPE_SUBMARINE;

    /** Rohre nach Einbaulage gruppieren — je Lage eine eigene Salve. */
    const gruppen = new Map<TubePosition, Tube[]>();
    for (const tube of tubes) {
      if (tube.status !== 'geladen' || !tube.armed) continue;
      const liste = gruppen.get(tube.position);
      if (liste) liste.push(tube);
      else gruppen.set(tube.position, [tube]);
    }
    if (gruppen.size === 0) return;

    let gefeuert = false;
    for (const [position, gruppe] of gruppen) {
      // Richtung: U-Boot schießt starr in die Einbaurichtung, das
      // Überwasserschiff auf die gezielte Peilung — sofern sie zur Seite passt.
      let richtung = tubeBearing(position, own.rotation);
      if (!isSubmarine) {
        if (!isFiniteNumber(bearing)) continue;
        const abweichung = Math.abs(angleDelta(richtung, bearing));
        if (abweichung > SIDE_LAUNCH_HALF_ANGLE_DEG + SECTOR_TOLERANCE_DEG) continue;
        richtung = bearing;
      }

      const laengs = position === 'bug' || position === 'heck';
      this.world.fireTorpedoSalvo(own, richtung, gruppe.length, laengs);
      for (const tube of gruppe) {
        tube.status = 'leer';
        tube.armed = false;
        tube.remaining = 0;
      }
      gefeuert = true;
    }

    if (gefeuert) this.sendOwn(socket, own);
  }

  /** Lädt laufende Rohre weiter. Läuft mit dem Simulationstakt. */
  private updateTubes(deltaSeconds: number): void {
    for (const [accountId, tubes] of this.tubes) {
      let fertig = false;
      for (const tube of tubes) {
        if (tube.status !== 'laedt') continue;
        tube.remaining -= deltaSeconds;
        if (tube.remaining > 0) continue;
        tube.remaining = 0;
        tube.status = 'geladen';
        fertig = true;
      }
      // Nur das FERTIGWERDEN meldet sich sofort; der laufende Ladebalken
      // steckt in der ownSignature und läuft über den normalen Vergleich.
      if (!fertig) continue;
      const socket = this.sockets.get(accountId);
      const own = this.world.get(accountId);
      if (socket && own) this.sendOwn(socket, own);
    }
  }

  /** Rohr-Zustände für das `own`-Ereignis. */
  private tubeStates(accountId: string): TubeState[] {
    const tubes = this.tubes.get(accountId) ?? [];
    return tubes.map((tube) => ({
      position: tube.position,
      status: tube.status,
      progress:
        tube.status === 'laedt' ? 1 - Math.min(tube.remaining / TUBE.reloadSeconds, 1) : 0,
      armed: tube.armed,
    }));
  }

  /**
   * Rohre bestücken — AUS DEM VORRAT.
   *
   * Früher lief jedes Boot mit vollen Rohren aus, ohne dass das etwas kostete.
   * Seit die Munition aus dem Inventar kommt, wäre das eine Torpedo-Quelle aus
   * dem Nichts: wer keine Torpedos gekauft hat, hätte trotzdem so viele
   * geladen, wie das Schiff Rohre besitzt. Jetzt wird beim Bestücken abgebucht
   * wie beim Nachladen von Hand — reicht der Vorrat nicht, bleibt das Rohr leer.
   */
  private resetTubes(accountId: string, model: VesselModel): void {
    const layout = tubeLayoutFor(model);
    const vorrat = this.ammo.get(accountId);
    this.tubes.set(
      accountId,
      layout.map((position) => {
        const vorhanden = (vorrat?.torpedo ?? 0) > 0;
        if (vorhanden && vorrat) vorrat.torpedo = (vorrat.torpedo ?? 0) - 1;
        return {
          position,
          status: vorhanden ? ('geladen' as const) : ('leer' as const),
          remaining: 0,
          armed: false,
        };
      }),
    );
  }

  /**
   * Munition aus dem TICKET an Bord nehmen — einmal je Einsatz, beim Beitritt.
   *
   * Was hier nicht steht, ist nicht dabei: ein leerer Werft-Slot heißt, dass
   * die Waffe im Gefecht gar nicht auftaucht. Und es gibt bewusst KEIN
   * Nachladen beim Respawn — der Vorrat gilt für den ganzen Einsatz, er kommt
   * aus dem Inventar des Kontos und ist dort bereits abgebucht.
   */
  private loadAmmoFromTicket(socket: GameSocket): void {
    const accountId = socket.data.accountId;
    const vorrat: Partial<Record<WeaponId, number>> = {};
    for (const posten of socket.data.loadout) {
      vorrat[posten.weapon] = (vorrat[posten.weapon] ?? 0) + Math.floor(posten.count);
      // Schaden der Sorte in die Welt — ab hier schlägt MK III härter zu als
      // MK I, ohne dass irgendeine Abschussstelle davon wissen muss.
      const schaden = this.ammoCatalog.damage(posten.itemId);
      if (schaden !== null) this.world.setWeaponDamage(accountId, posten.weapon, schaden);
    }
    this.ammo.set(accountId, vorrat);
    this.nextFireTick.delete(accountId);
  }

  /**
   * Was von der Munition übrig ist — Grundlage der Rückgabe ans Backend.
   *
   * Gezählt wird je ITEM, nicht je Waffe: nur so weiß die api, was sie
   * gutschreiben soll. Geladene Rohre zählen mit, sie sind ja noch da.
   */
  private leftovers(
    accountId: string,
    aboard: readonly LoadoutEntryStack[],
  ): LoadoutEntryStack[] {
    const vorrat = this.ammo.get(accountId);
    if (!vorrat) return [];
    const inRohren = (this.tubes.get(accountId) ?? []).filter(
      (rohr) => rohr.status === 'geladen',
    ).length;

    const rest: LoadoutEntryStack[] = [];
    for (const posten of aboard) {
      let uebrig = vorrat[posten.weapon] ?? 0;
      // Torpedos in geladenen Rohren sind aus dem Vorrat verschwunden, aber
      // nicht verschossen — sonst verlöre jeder, der mit vollen Rohren
      // aussteigt, genau diese Torpedos.
      if (posten.weapon === 'torpedo') uebrig += inRohren;
      const zurueck = Math.min(Math.max(Math.floor(uebrig), 0), posten.count);
      if (zurueck > 0) rest.push({ weapon: posten.weapon, itemId: posten.itemId, count: zurueck });
    }
    return rest;
  }

  /**
   * Meldet dem Backend das ERFOLGREICHE Einsatzende: unverbrauchte Munition
   * zurück, gesicherten Loot gutschreiben.
   *
   * Seit Protokoll 14 gibt es genau zwei Aufrufer — die Extraktion und das
   * Herunterfahren des Servers (das ist nicht die Schuld des Spielers). Wer
   * die Karte über den Knopf verlässt oder die Verbindung verliert, landet
   * hier NICHT: Loot und Ausrüstung sind dann weg. Das ist die Regel, die die
   * Extraktion überhaupt zu einer Entscheidung macht — und nebenbei der
   * Riegel gegen „Kabel ziehen rettet die Fracht".
   *
   * Fire-and-forget: ein hängendes Backend darf das Aufräumen nicht aufhalten.
   * Kommt die Meldung nicht an, geht der Fehlerfall zulasten des Spielers,
   * nie der Wirtschaft.
   */
  private reportSortieEnd(
    accountId: string,
    aboard: readonly LoadoutEntryStack[],
    coins: number,
  ): void {
    const rest = this.leftovers(accountId, aboard);
    if (rest.length === 0 && coins <= 0) return;
    fetch(`${env.apiInternalUrl}/api/internal/sortie-end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': env.internalKey },
      body: JSON.stringify({ accountId, leftovers: rest, coins }),
      signal: AbortSignal.timeout(3000),
    }).catch((error) => {
      console.warn(`[game-server] Abrechnung für ${accountId} fehlgeschlagen:`, error);
    });
  }

  private sendOwn(socket: GameSocket, vessel: Vessel): void {
    const accountId = socket.data.accountId;
    const ammo = this.ammo.get(accountId);
    socket.emit('own', {
      telegraphStep: vessel.telegraphStep,
      waypoint: vessel.waypoint ? { ...vessel.waypoint } : null,
      diveTarget: vessel.diveTarget,
      periscopeTarget: vessel.periscopeTarget,
      hp: this.world.hp(accountId),
      armor: this.world.armorState(accountId),
      // NUR die Waffen an Bord. Ein fehlender Schlüssel heißt „nicht dabei" —
      // die Gefechtsleiste blendet den Slot dann ganz aus, statt eine Waffe mit
      // 0 Schuss anzubieten, die es auf diesem Einsatz gar nicht gibt.
      ammo: { ...(ammo ?? {}) },
      tubes: this.tubeStates(accountId),
      loot: this.loot.get(accountId) ?? 0,
      extractionSeconds: this.extractionSeconds.get(accountId) ?? 0,
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
      this.bots?.update(SIM_STEP_SECONDS);
      const events = this.world.update(SIM_STEP_SECONDS);
      this.handleCombatEvents(events);
      this.updateLootAndExtraction(SIM_STEP_SECONDS);
      this.updateRespawns(SIM_STEP_SECONDS);
      this.updateTubes(SIM_STEP_SECONDS);
      this.accumulator -= SIM_STEP_SECONDS;
      this.tick += 1;
      steps += 1;
      // Ankunft, Wachhund und Treffer ändern den Besitzer-Zustand von selbst —
      // der Betroffene muss das erfahren, sonst zeigt seine Anzeige einen
      // Befehl oder Zustand, den es nicht mehr gibt.
      this.notifyChangedOwners(before);
    }

    this.sinceBroadcast += elapsed;
    if (this.sinceBroadcast >= 1 / BROADCAST_HZ) {
      this.sinceBroadcast = 0;
      this.broadcastState();
    }
  }

  /**
   * Wertet die Kampfereignisse eines Simulationsschritts aus: fx-Meldungen an
   * alle in Sonar-Reichweite, Versenkungen räumen das Fahrzeug aus der Welt
   * und stoßen den Wiedereinstieg an — Spieler über die Warteliste, Bots über
   * ihre eigene.
   */
  private handleCombatEvents(events: WorldEvents): void {
    for (const impact of events.impacts) this.emitFx('impact', impact.x, impact.y);

    for (const wreck of events.destroyed) {
      // fx VOR dem Entfernen — der Betroffene selbst ist noch Beobachter und
      // soll seinen eigenen Untergang sehen.
      this.emitFx('sunk', wreck.x, wreck.y);

      const vessel = this.world.get(wreck.id);
      const model = vessel?.model ?? 'fregatte01';
      this.world.remove(wreck.id);

      const socket = this.sockets.get(wreck.id);
      if (socket) {
        /*
         * Spieler-Drop: Einsatzgebühr des TICKET-Schiffs (nur beim ersten
         * Untergang — sie wurde einmal bezahlt) plus alles, was er trug.
         * Der Getragene Loot geht damit über Bord, nicht unter: wer das Wrack
         * plündert, übernimmt die Fracht.
         */
        const ticketModel = socket.data.shipModel;
        const gebuehr =
          !this.feeDropped.has(wreck.id) && isPlayableModel(ticketModel)
            ? SHIP_ACCESS[ticketModel].sortieCost
            : 0;
        this.feeDropped.add(wreck.id);
        const fracht = this.loot.get(wreck.id) ?? 0;
        this.loot.set(wreck.id, 0);
        this.world.spawnCrate(wreck.x, wreck.y, gebuehr + fracht);

        this.pendingRespawns.set(wreck.id, { seconds: RESPAWN_SECONDS, model });
        socket.emit('destroyed', { respawnSeconds: RESPAWN_SECONDS });
        console.log(`[game-server] ${socket.data.name} versenkt — Respawn in ${RESPAWN_SECONDS} s.`);
      } else {
        // NPC-Drop nach Beutetabelle; Modelle ohne Eintrag lassen nichts fallen.
        this.world.spawnCrate(wreck.x, wreck.y, NPC_LOOT[model] ?? 0);
        this.bots?.notifyDestroyed(wreck.id);
      }
      this.notifyLeft(wreck.id);
    }
  }

  /**
   * Aufsammeln und Extraktion — läuft mit dem Simulationstakt.
   *
   * Aufsammeln: Kisten im Radius gehen als FRACHT an Bord. Extraktion: wer
   * sich ununterbrochen in einer Zone hält, bekommt nach EXTRACTION_SECONDS
   * Loot gutgeschrieben und Restmunition zurück — das ist seit Protokoll 14
   * der EINZIGE Weg, beides zu behalten.
   */
  private updateLootAndExtraction(deltaSeconds: number): void {
    for (const [accountId, socket] of this.sockets) {
      if (this.extracting.has(accountId)) continue;
      const vessel = this.world.get(accountId);
      if (!vessel) {
        this.extractionSeconds.delete(accountId);
        continue;
      }

      const eingesammelt = this.world.pickupCrates(vessel, LOOT_PICKUP_RADIUS);
      if (eingesammelt > 0) {
        this.loot.set(accountId, (this.loot.get(accountId) ?? 0) + eingesammelt);
        console.log(`[game-server] ${socket.data.name} birgt Loot: ${eingesammelt} Coins.`);
      }

      // Zonenzeit: drinnen läuft sie auf, draußen fällt sie sofort auf null —
      // Extraktion ist eine ununterbrochene Acht-Sekunden-Entscheidung, kein
      // Sparbuch über mehrere Vorbeifahrten.
      const zone = this.world.findExitPointAt(vessel.x, vessel.y);
      if (!zone) {
        this.extractionSeconds.delete(accountId);
        continue;
      }
      const stand = (this.extractionSeconds.get(accountId) ?? 0) + deltaSeconds;
      this.extractionSeconds.set(accountId, stand);
      if (stand >= EXTRACTION_SECONDS) this.extract(accountId, socket);
    }
  }

  /** Erfolgreiche Extraktion: gutschreiben, melden, Verbindung beenden. */
  private extract(accountId: string, socket: GameSocket): void {
    this.extracting.add(accountId);
    const coins = this.loot.get(accountId) ?? 0;
    // Abrechnung JETZT, solange Vorrat und Rohre noch stehen — der
    // Disconnect-Handler räumt sie gleich weg.
    this.reportSortieEnd(accountId, socket.data.loadout, coins);
    socket.emit('extracted', { coins });
    console.log(`[game-server] ${socket.data.name} extrahiert — ${coins} Coins gesichert.`);
    // Trennung leicht verzögert, damit das extracted-Paket sicher rausgeht —
    // ein disconnect im selben Zug kann es sonst verschlucken.
    setTimeout(() => socket.disconnect(true), 150);
  }

  /** Setzt versenkte Spieler nach Ablauf ihrer Wartezeit wieder ein. */
  private updateRespawns(deltaSeconds: number): void {
    for (const [accountId, pending] of this.pendingRespawns) {
      pending.seconds -= deltaSeconds;
      if (pending.seconds > 0) continue;
      this.pendingRespawns.delete(accountId);

      const socket = this.sockets.get(accountId);
      // Inzwischen getrennt — der Disconnect-Handler hat schon aufgeräumt.
      if (!socket) continue;

      // Wiedereinstieg heißt frisches Boot: die Panzerung des Einsatzes steht
      // wieder ganz. Sie ist mit dem Ticket bezahlt, nicht mit dem Leben.
      const vessel = this.world.spawn(
        accountId,
        socket.data.name,
        pending.model,
        this.armor.get(socket.data.armorItem),
      );
      // KEIN Auffüllen der Munition: der Vorrat gilt für den ganzen Einsatz.
      // Er kommt aus dem Inventar und ist dort schon abgebucht — ein Respawn
      // wäre sonst der bequemste Weg, Torpedos aus dem Nichts zu bekommen.
      // Der Schaden je Sorte muss dagegen neu gesetzt werden: `world.remove`
      // beim Untergang hat ihn mitgenommen.
      for (const posten of socket.data.loadout) {
        const schaden = this.ammoCatalog.damage(posten.itemId);
        if (schaden !== null) this.world.setWeaponDamage(accountId, posten.weapon, schaden);
      }
      this.resetTubes(accountId, pending.model);
      this.sendOwn(socket, vessel);
    }
  }

  /**
   * Kampf-Effekt an alle, deren Sonar den Punkt erfasst. Zuverlässig statt
   * volatile: eine Explosion, die im Paketverlust untergeht, sieht wie ein
   * Fehler aus.
   */
  private emitFx(kind: 'impact' | 'sunk', x: number, y: number): void {
    for (const [accountId, socket] of this.sockets) {
      const observer = this.world.get(accountId);
      if (!observer) continue;
      const dx = x - observer.x;
      const dy = y - observer.y;
      // Dieselbe gedämpfte Reichweite wie Fahrzeug- und Projektilfilter. Mit
      // dem rohen Basiswert kämen bei Seegang Explosionen samt Koordinaten für
      // Gefechte durch, die das eigene Sonar gar nicht sieht — genau die
      // Aufklärung, die die Filterung verhindern soll.
      const range = this.sensorRangeFor(observer);
      if (dx * dx + dy * dy <= range * range) socket.emit('fx', { kind, x, y });
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
    const projectiles = this.world.projectileStates();
    const crates = this.world.crateStates();

    for (const [accountId, socket] of this.sockets) {
      const observer = this.world.get(accountId);
      if (!observer) {
        // Versenkt und noch nicht wieder eingesetzt: LEERER Zustand statt
        // Funkstille. Ohne ihn behielte der Client seinen letzten Stand samt
        // eigenem Wrack — und der Respawn käme dort nie als frischer Spawn an
        // (Versenkt-Meldung bliebe hängen, Kamera am verwaisten Objekt).
        socket.volatile.emit('state', { tick: this.tick, players: [], projectiles: [], crates: [] });
        continue;
      }

      const players: PlayerState[] = [];
      for (const id of this.updateDetection(accountId, observer)) {
        const state = states.get(id);
        if (state) players.push(state);
      }

      // Projektile durch denselben Sonar-Filter — ohne Hysterese: sie laufen
      // mit ~68 m/s, ein Flackern an der Reichweitengrenze dauert Sekundenbruchteile.
      const range = this.sensorRangeFor(observer);
      const visible = projectiles.filter((p) => {
        const dx = p.x - observer.x;
        const dy = p.y - observer.y;
        return dx * dx + dy * dy <= range * range;
      });

      // Kisten ebenso: eine Kiste außerhalb der Sonar-Reichweite wäre die
      // Information, dass dort irgendwo ein Gefecht endete — Aufklärung.
      const sichtbareKisten = crates.filter((c) => {
        const dx = c.x - observer.x;
        const dy = c.y - observer.y;
        return dx * dx + dy * dy <= range * range;
      });

      socket.volatile.emit('state', {
        tick: this.tick,
        players,
        projectiles: visible,
        crates: sichtbareKisten,
      });
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
  /**
   * Wirksame Sonarreichweite eines Beobachters unter dem Seegang dieser Karte.
   * Wird an DREI Stellen gebraucht (Fahrzeug-, Projektil- und fx-Filter) —
   * deshalb ein Helfer statt dreimal derselben Rechnung. Wer eine vierte
   * Filterstelle baut, nimmt bitte auch diese hier.
   */
  /**
   * Die Wetterlage mit FORTGESCHRIEBENER Tageszeit. Steht die Uhr
   * (`dayLengthMinutes` 0), ist das die gespeicherte Lage unverändert.
   */
  private currentWeather(): WeatherState {
    if (this.weather.dayLengthMinutes <= 0) return this.weather;
    const verstrichen = Number(process.hrtime.bigint() - this.weatherSetAt) / 1e9;
    return { ...this.weather, timeOfDay: currentHour(this.weather, verstrichen) };
  }

  private sensorRangeFor(observer: Vessel): number {
    return effectiveSensorRange(observer.sensorRange, this.weather.seaState, observer.depth);
  }

  private updateDetection(accountId: string, observer: Vessel): Set<string> {
    let held = this.detected.get(accountId);
    if (!held) {
      held = new Set();
      this.detected.set(accountId, held);
    }

    // Seegang frisst Ortung: Wellenlärm an der Oberfläche kürzt die
    // Reichweite. Wer getaucht horcht, ist davon kaum betroffen — das ist der
    // Grund, warum schwere See dem U-Boot in die Hände spielt.
    const reichweite = this.sensorRangeFor(observer);
    const acquire = reichweite;
    const release = reichweite * ORTUNG_HYSTERESE;

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

  /**
   * Kurzform des privaten Zustands, um Änderungen zu erkennen. HP und Munition
   * gehören dazu — ein Treffer muss das `own` genauso auslösen wie eine Ankunft.
   */
  private ownSignature(accountId: string, vessel: Vessel): string {
    const ammo = this.ammo.get(accountId);
    return (
      `${vessel.serial}:${vessel.telegraphStep}:${vessel.waypoint ? 'z' : '-'}:` +
      `${vessel.diveTarget ? 't' : 'o'}:${vessel.periscopeTarget ? 'p' : '-'}:` +
      // Panzerung mit: ein Treffer, den sie ganz schluckt, ändert die HP nicht —
      // ohne sie hier bliebe die Leiste bis zum nächsten Befehl stehen.
      `${this.world.hp(accountId)}:${this.world.armorState(accountId)?.percent ?? -1}:` +
      `${ammo?.torpedo ?? 0}:${ammo?.taeuschkoerper ?? 0}:` +
      `${ammo?.geschuetz ?? 0}:${ammo?.wasserbombe ?? 0}:` +
      // Loot und Zonenzeit: das Aufsammeln muss sofort sichtbar werden, und
      // der Extraktionsbalken läuft — viertelsekundengenau quantisiert, damit
      // das own-Ereignis in der Zone mit 4 Hz statt 20 Hz feuert.
      `${this.loot.get(accountId) ?? 0}:` +
      `${Math.floor((this.extractionSeconds.get(accountId) ?? 0) * 4)}:` +
      // Rohre mit: der Ladebalken läuft, und ohne ihn in der Signatur bliebe
      // die Anzeige beim Ladevorgang stehen.
      (this.tubes.get(accountId) ?? [])
        .map((t) => `${t.status[0]}${t.armed ? 'S' : '-'}${Math.round(t.remaining * 4)}`)
        .join(',')
    );
  }

  private ownSignatures(): Map<string, string> {
    const map = new Map<string, string>();
    for (const accountId of this.sockets.keys()) {
      const vessel = this.world.get(accountId);
      if (vessel) map.set(accountId, this.ownSignature(accountId, vessel));
    }
    return map;
  }

  private notifyChangedOwners(before: Map<string, string>): void {
    for (const [accountId, socket] of this.sockets) {
      const vessel = this.world.get(accountId);
      if (!vessel) continue;
      if (before.get(accountId) !== this.ownSignature(accountId, vessel)) this.sendOwn(socket, vessel);
    }
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
