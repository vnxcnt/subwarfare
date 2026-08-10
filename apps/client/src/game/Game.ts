import { Application } from 'pixi.js';
import { DEMO_TRAFFIC, DEMO_VESSEL, RENDERER, SIM, VESSEL_DEMO, VISION } from '../config';
import { setSunkNotice, writeHud } from '../state/hud';
import { CameraController } from './CameraController';
import { DemoTraffic } from './DemoTraffic';
import type {
  OwnStatePayload,
  PlayerState,
  ProjectileState,
  ShipStats,
  StatePayload,
  VesselModel,
  WeaponId,
} from '@subwarfare/shared';
import {
  DEFAULT_SHIP_STATS,
  DESTROYER,
  TORPEDO,
  Vessel,
  angleDelta,
  norm360,
  profileForShip,
} from '@subwarfare/shared';
import { GameSocket } from '../network/GameSocket';
import { OrderController } from './OrderController';
import { getTilt, setTilt } from './Projection';
import { loadVesselTextures } from './textures';
import { World } from './World';
import { isTextEntry } from '../ui/dom';

/** Zugangsdaten für den Online-Betrieb — Ticket aus der Lobby. */
export interface OnlineSession {
  gameUrl: string;
  ticket: string;
  /** Wird gerufen, wenn die Partie endet — Rauswurf oder Verbindungsabriss. */
  onEnded: (message: string) => void;
}

/**
 * Bindeglied zwischen Vue und PixiJS: initialisiert den Renderer, hängt das
 * Canvas in ein DOM-Element und treibt die Welt über den Pixi-Ticker an.
 *
 * Zwei Betriebsarten, entschieden bei `init`:
 * - **Online** ist der Normalfall: der Server simuliert, hier wird nur
 *   dargestellt. Kein lokales Spawnen, kein Demoverkehr, kein `simulate()` —
 *   die Fahrzeuge übernehmen mit `applyState`, was der Broadcast liefert.
 * - **Offline** (`init` ohne Session) ist eine rein INTERNE Fähigkeit mit
 *   lokaler Simulation — aus dem Produkt nicht erreichbar (kein Knopf, keine
 *   Route). Sie bleibt für die Entwicklung der Darstellung ohne Server und
 *   als Grundlage für einen späteren Übungsmodus.
 */
export class Game {
  private app: Application | null = null;
  private world: World | null = null;
  private camera: CameraController | null = null;
  private orders: OrderController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private tiltKeys: ((event: KeyboardEvent) => void) | null = null;
  private traffic: DemoTraffic | null = null;
  private accumulator = 0;

  private socket: GameSocket | null = null;
  private selfId: string = DEMO_VESSEL.id;
  /**
   * `own` kann vor dem ersten `state` eintreffen — dann existiert das eigene
   * Fahrzeug noch nicht. Der letzte Stand wird beim Spawn nachgetragen.
   */
  private pendingOwn: OwnStatePayload | null = null;

  /**
   * Eigene Lebenspunkte und Munition aus dem `own` — leben hier statt auf dem
   * Vessel, weil sie kein Fahrzustand sind: das Fahrzeug kann tot (entfernt)
   * sein, während das HUD noch den letzten Stand zeigt.
   */
  private ownHp: number | null = null;
  private ownAmmo: Partial<Record<WeaponId, number>> = {};

  /**
   * Schiffs-Basiswerte aus der `welcome` — die Zahlen, mit denen der Server
   * tatsächlich fährt. Anzeige-Wahrheit für Telegraf und Munitionsleiste.
   */
  private readonly shipCatalog = new Map<string, ShipStats>();
  /** Welches Profil ein Fahrzeug gerade fährt — für den Wechsel bei applyState. */
  private readonly appliedProfileModel = new Map<string, string>();

  /**
   * Snapshot-Puffer für die Darstellung.
   *
   * Der Server schickt 20 Zustände pro Sekunde; hart übernommen springt jede
   * Position alle 50 ms um knapp einen Meter — das ständige „Laggen". Statt-
   * dessen rendert der Client die Welt ~125 ms in der Vergangenheit und
   * INTERPOLIERT zwischen den beiden umschließenden Snapshots: Bewegung wird
   * frameglatt, und einzelne verlorene `volatile`-Pakete fallen in den Verzug.
   */
  private readonly snapshots: Array<{
    tick: number;
    byId: Map<string, PlayerState>;
    projectiles: Map<string, ProjectileState>;
  }> = [];
  /** Darstellungszeit in Server-Ticks (20/s), läuft dem Netz hinterher. */
  private renderTick = -1;
  private latestTick = -1;

  private static readonly TICKS_PER_SECOND = 1 / SIM.fixedDt;
  /** Render-Verzug in Ticks. 2,5 Ticks = 125 ms — überbrückt einen Paketverlust. */
  private static readonly DELAY_TICKS = 2.5;

  get application(): Application | null {
    return this.app;
  }

  /** Für HUD-Anzeigen (Position, Zoom, Kurs). Null, solange nicht initialisiert. */
  get scene(): World | null {
    return this.world;
  }

  /** Das eigene Boot. Online erst vorhanden, wenn der erste `state` da ist. */
  get ownVessel(): Vessel | undefined {
    return this.world?.entities.get(this.selfId);
  }

  /** Basiswerte eines Modells — Katalog vom Server, sonst die shared-Defaults. */
  shipStats(model: string): ShipStats {
    return (
      this.shipCatalog.get(model) ??
      DEFAULT_SHIP_STATS[model as VesselModel] ??
      DEFAULT_SHIP_STATS.fregatte01
    );
  }

  /** Hält das Fahrprofil eines Fahrzeugs auf dem Stand seines Modells. */
  private ensureProfile(vessel: Vessel): void {
    if (this.appliedProfileModel.get(vessel.id) === vessel.model) return;
    vessel.applyProfile(profileForShip(DESTROYER, this.shipStats(vessel.model)));
    this.appliedProfileModel.set(vessel.id, vessel.model);
  }

  get isOnline(): boolean {
    return this.socket !== null;
  }

  /**
   * Neigung der Ansicht — `sin(Höhenwinkel der Kamera)`. Kleiner = flacherer
   * Blick, stärkere Höhenwirkung. Greift ab dem nächsten Frame überall.
   */
  get viewTilt(): number {
    return getTilt();
  }

  setViewTilt(value: number): void {
    setTilt(value);
  }

  async init(host: HTMLElement, session: OnlineSession | null = null): Promise<void> {
    if (this.app) return;

    const app = new Application();
    await app.init({
      resizeTo: host,
      background: RENDERER.backgroundColor,
      antialias: RENDERER.antialias,
      preference: RENDERER.preference,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, RENDERER.maxResolution),
    });

    host.appendChild(app.canvas);
    // `resizeTo` misst erst beim nächsten Resize-Event — einmal explizit anstoßen,
    // damit der Renderer nicht auf der Default-Größe 800×600 hängen bleibt.
    app.resize();
    this.app = app;

    // Pixis `resizeTo` hört ausschließlich auf `window.resize`. Ändert der
    // Container seine Größe ohne Fensterwechsel (Layout, Sidebar, Splitpane),
    // bleibt der Renderer sonst auf der alten Größe stehen.
    this.resizeObserver = new ResizeObserver(() => app.resize());
    this.resizeObserver.observe(host);

    // Muss VOR dem ersten spawn stehen — `VesselView` greift synchron auf die
    // Textur zu und fiele sonst auf das Vektorpolygon zurück.
    await loadVesselTextures();

    const world = new World();
    app.stage.addChild(world.container);
    this.world = world;

    if (session) this.initOnline(session);
    else this.initOffline();

    world.applyCamera(app.screen.width, app.screen.height);

    this.camera = new CameraController(app.canvas, world, () => world.stopFollowing());
    this.orders = new OrderController(app.canvas, world, (x, y) => this.orderWaypoint(x, y));

    app.ticker.add((ticker) => this.step(ticker.deltaMS / 1000));

    if (import.meta.env.DEV) {
      // Zugriff auf Renderer und Welt aus der Browser-Konsole. Nur im
      // Dev-Build — im Produktionsbundle entfernt Vite den Zweig komplett.
      (window as unknown as { __game?: Game }).__game = this;

      // Neigung im laufenden Bild eindrehen. Rein visuelle Einstellung, die man
      // in Bewegung beurteilen muss — deshalb Tasten statt Config-Reload.
      this.tiltKeys = (event: KeyboardEvent) => {
        // Nicht zuschlagen, während jemand in ein Eingabefeld tippt.
        if (isTextEntry(event.target)) return;

        if (event.key === '[') setTilt(getTilt() - 0.02);
        else if (event.key === ']') setTilt(getTilt() + 0.02);
        else return;
        event.preventDefault();
      };
      window.addEventListener('keydown', this.tiltKeys);
    }
  }

  /** Offline-Demobetrieb: lokales Boot, Demoverkehr, eigene Simulation. */
  private initOffline(): void {
    const world = this.world!;
    this.selfId = DEMO_VESSEL.id;
    world.entities.setOwnId(this.selfId);

    const demo = world.entities.spawn(new Vessel({ ...DEMO_VESSEL }, VESSEL_DEMO));

    // Fremde Kontakte, damit das Sonar etwas anzeigt. Echte Fahrzeuge mit
    // derselben Physik — nur die Zielwahl ist zufällig.
    const traffic = new DemoTraffic();
    for (const entry of DEMO_TRAFFIC) {
      const vessel = world.entities.spawn(new Vessel({ ...entry }, VESSEL_DEMO));
      if (entry.patrol) traffic.add(vessel);
    }
    this.traffic = traffic;

    world.setZoom(0.55);
    world.centerOn(demo.x, demo.y);
    world.follow(demo);
  }

  /** Online: Karte und Fahrzeuge kommen vollständig vom Server. */
  private initOnline(session: OnlineSession): void {
    const world = this.world!;

    const socket = new GameSocket();
    this.socket = socket;

    socket.connect(session.gameUrl, session.ticket, {
      onWelcome: (payload) => {
        this.selfId = payload.selfId;
        world.entities.setOwnId(payload.selfId);
        for (const ship of payload.ships) this.shipCatalog.set(ship.model, ship);
        world.setMap(payload.map);
      },
      onState: (payload) => this.ingestState(payload),
      onOwn: (payload) => {
        this.pendingOwn = payload;
        this.ownHp = payload.hp;
        this.ownAmmo = payload.ammo;
        this.ownVessel?.applyOwnState(payload);
      },
      onPlayerLeft: (id) => {
        if (id !== this.selfId) world.entities.remove(id);
      },
      onFx: (payload) => world.spawnImpact(payload.x, payload.y, payload.kind === 'sunk'),
      onDestroyed: (payload) => {
        // Das eigene Boot verschwindet mit dem nächsten Broadcast von selbst
        // aus dem Bestand — hier bleibt nur die Meldung an den Spieler.
        setSunkNotice(Date.now() + payload.respawnSeconds * 1000);
      },
      onEnded: (message) => session.onEnded(message),
    });

    world.setZoom(0.55);
  }

  /**
   * Ein `state`-Broadcast kommt an: puffern und den Bestand abgleichen.
   *
   * Neue Kennungen spawnen sofort (an ihrer echten Position), verschwundene
   * werden sofort entfernt — nur die BEWEGUNG bestehender Fahrzeuge läuft
   * über die Interpolation in `applyInterpolated`, nicht über diesen Pfad.
   */
  private ingestState(payload: StatePayload): void {
    const world = this.world;
    if (!world) return;

    // volatile-Pakete können ausfallen, aber nicht überholen — ein älterer
    // Tick wäre ein Reconnect-Artefakt und würde die Uhr rückwärts reißen.
    if (payload.tick <= this.latestTick) return;
    this.latestTick = payload.tick;

    this.snapshots.push({
      tick: payload.tick,
      byId: new Map(payload.players.map((player) => [player.id, player])),
      // Ältere Server (Protokoll < 4) schicken das Feld nicht — leer statt Crash.
      projectiles: new Map((payload.projectiles ?? []).map((p) => [p.id, p])),
    });
    if (this.renderTick < 0) this.renderTick = payload.tick - Game.DELAY_TICKS;

    const seen = new Set<string>();
    for (const player of payload.players) {
      seen.add(player.id);
      if (world.entities.get(player.id)) continue;

      const vessel = world.entities.spawn(
        new Vessel(
          {
            id: player.id,
            name: player.name,
            model: player.model,
            x: player.x,
            y: player.y,
            rotation: player.rotation,
          },
          profileForShip(DESTROYER, this.shipStats(player.model)),
        ),
      );
      this.appliedProfileModel.set(player.id, player.model);
      vessel.applyState(player);

      if (player.id === this.selfId) {
        // Der zwischengespeicherte Besitzer-Zustand gehört auf das frisch
        // gespawnte Boot — er kam möglicherweise vor diesem Broadcast an.
        if (this.pendingOwn) vessel.applyOwnState(this.pendingOwn);
        // Bei JEDEM Selbst-Spawn zentrieren und folgen — beim ersten Betreten
        // genauso wie beim Wiedereinstieg nach einer Versenkung (das alte
        // Follow-Ziel ist dann ein verwaistes Objekt).
        world.centerOn(vessel.x, vessel.y);
        world.follow(vessel);
        setSunkNotice(null);
      }
    }

    // Rückwärts unnötig — `remove` über eine Kopie der Kennungen.
    for (const vessel of [...world.entities.models()]) {
      if (!seen.has(vessel.id)) world.entities.remove(vessel.id);
    }
  }

  /**
   * Ein Darstellungsschritt der Interpolation.
   *
   * Die Render-Uhr läuft in Echtzeit mit und wird sanft auf „neuester Tick
   * minus Verzug" gezogen — so schluckt sie Taktdrift zwischen Client und
   * Server, ohne sichtbar zu springen. Nur nach großen Aussetzern (Tab war
   * verborgen) schnappt sie hart auf das Ziel.
   */
  private applyInterpolated(frameSeconds: number): void {
    const world = this.world;
    if (!world || this.snapshots.length === 0 || this.renderTick < 0) return;

    this.renderTick += frameSeconds * Game.TICKS_PER_SECOND;
    const target = this.latestTick - Game.DELAY_TICKS;
    const drift = target - this.renderTick;
    if (Math.abs(drift) > 10) this.renderTick = target;
    else this.renderTick += drift * Math.min(1, frameSeconds * 3);

    // Verbrauchte Snapshots abwerfen — einer VOR der Render-Uhr muss bleiben.
    while (this.snapshots.length > 2 && (this.snapshots[1]?.tick ?? Infinity) <= this.renderTick) {
      this.snapshots.shift();
    }

    // Umschließendes Paar suchen. Hinter dem neuesten Stand wird geklemmt
    // statt extrapoliert — lieber 50 ms stehen als übers Ziel hinausschießen.
    let older = this.snapshots[0]!;
    let newer = older;
    for (const snapshot of this.snapshots) {
      if (snapshot.tick <= this.renderTick) older = snapshot;
      if (snapshot.tick >= this.renderTick) {
        newer = snapshot;
        break;
      }
      newer = snapshot;
    }

    const span = newer.tick - older.tick;
    const t = span > 0 ? Math.min(Math.max((this.renderTick - older.tick) / span, 0), 1) : 1;

    for (const vessel of world.entities.models()) {
      const a = older.byId.get(vessel.id);
      const b = newer.byId.get(vessel.id);
      // Frisch gespawnt oder kurz vor dem Entfernen: den vorhandenen Stand
      // halten statt zwischen Lücken zu raten.
      const state = a && b ? lerpState(a, b, t) : (b ?? a);
      if (state) {
        vessel.applyState(state);
        // Modellwechsel (Dev-Menü) bringt neue Fahrwerte mit — fürs HUD
        // (Telegraf-Höchstfahrt) muss das Profil mitziehen.
        this.ensureProfile(vessel);
      }
    }

    // Projektile: Bestand aus dem NEUEREN Snapshot (wer dort fehlt, ist
    // eingeschlagen oder abgelaufen), Bewegung zwischen beiden interpoliert.
    const projectiles: ProjectileState[] = [];
    for (const [id, b] of newer.projectiles) {
      const a = older.projectiles.get(id);
      projectiles.push(a ? lerpProjectile(a, b, t) : b);
    }
    world.entities.applyProjectiles(projectiles);
  }

  /* --- Befehle -------------------------------------------------------- */

  /**
   * Fahrbefehl. Online geht NUR die Absicht ans Netz; die Bestätigung kommt
   * über das `own`-Ereignis zurück. Offline wirkt der Befehl direkt.
   */
  orderWaypoint(x: number, y: number): void {
    if (this.socket) {
      this.socket.sendWaypoint(x, y);
      return;
    }
    this.ownVessel?.orderMoveTo(x, y);
  }

  orderTelegraph(step: number): void {
    if (this.socket) {
      this.socket.sendTelegraph(step);
      return;
    }
    this.ownVessel?.setTelegraph(step);
  }

  /** Tauchbefehl. Online als Absicht ans Netz, offline direkt. */
  orderDive(submerged: boolean): void {
    if (this.socket) {
      this.socket.sendDive(submerged);
      return;
    }
    this.ownVessel?.orderDive(submerged);
  }

  /** Periskop-Befehl. Gleiche Naht wie das Tauchen. */
  orderPeriscope(extended: boolean): void {
    if (this.socket) {
      this.socket.sendPeriscope(extended);
      return;
    }
    this.ownVessel?.orderPeriscope(extended);
  }

  /**
   * Feuerbefehl — nur online, der Server rechnet Abschuss und Kollision.
   * Offline (interner Darstellungsmodus) gibt es keine Projektile.
   */
  orderFire(weapon: WeaponId): void {
    this.socket?.sendFire(weapon);
  }

  /** Eigene Lebenspunkte laut Server; null, solange kein `own` ankam. */
  get hp(): number | null {
    return this.ownHp;
  }

  /** Restmunition einer Waffe laut Server; Kapazität als Startwert vor dem `own`. */
  ammoFor(weapon: WeaponId): number {
    return this.ownAmmo[weapon] ?? (weapon === 'torpedo' ? TORPEDO.capacity : 0);
  }

  /**
   * Entwickler-Befehl: eigenes Schiffsmodell wechseln. Geht als Absicht ans
   * Netz; der Server prüft Rolle und Modell und broadcastet das Ergebnis.
   * Offline (interner Modus) wirkt er direkt.
   */
  devSetModel(model: VesselModel): void {
    if (this.socket) {
      this.socket.sendDevModel(model);
      return;
    }
    const own = this.ownVessel;
    if (own) own.model = model;
  }

  nudgeTelegraph(delta: number): void {
    const own = this.ownVessel;
    if (!own) return;
    // Auch online auf dem letzten bekannten Stand aufsetzen — der Server
    // klemmt ohnehin auf den gültigen Bereich.
    this.orderTelegraph(own.telegraphStep + delta);
  }

  /**
   * Ein vollständiger Frame. Hängt am Pixi-Ticker, ist aber bewusst eine eigene
   * Methode: so lässt sich das Spiel ohne `requestAnimationFrame` weiterdrehen,
   * etwa zum Prüfen in einer Umgebung, in der der Tab nicht gerendert wird.
   */
  step(frameSeconds: number): void {
    const app = this.app;
    const world = this.world;
    if (!app || !world) return;

    if (!this.socket) {
      // Feste Schritte: das Fahrmodell ist nichtlinear und mit variablem dt
      // nicht reproduzierbar. Der Deckel begrenzt das Aufholen nach einem
      // Tab-Wechsel. Online entfällt das komplett — der Server simuliert, und
      // ein zweiter Rechner hier wäre eine zweite Wahrheit.
      this.accumulator += Math.min(frameSeconds, 0.1);
      let steps = 0;
      while (this.accumulator >= SIM.fixedDt && steps < SIM.maxCatchupSteps) {
        world.simulate(SIM.fixedDt);
        this.accumulator -= SIM.fixedDt;
        steps += 1;
      }
      this.traffic?.update(world.currentMap);
    } else {
      // Online: Positionen frameglatt aus dem Snapshot-Puffer statt hart vom
      // letzten Broadcast.
      this.applyInterpolated(frameSeconds);
    }

    // Unterwasser-Stimmung der Karte folgt der Tiefe des EIGENEN Boots.
    const own = this.ownVessel;
    world.setUnderwaterDepth(own?.depth ?? 0);

    // Optische Sicht: an der Oberfläche ein Kreis, der mit der Tauchtiefe
    // schrumpft; unter Wasser nur der Periskop-Kegel in Fahrtrichtung, der
    // mit dem Ausfahren aufgeht. Beides zugleich während der Übergänge.
    if (own) {
      const circleRadius = VISION.radius * (1 - own.depth);
      const coneLength = VISION.coneLength * own.periscope * own.depth;
      world.setVision(own.x, own.y, own.rotation, circleRadius, coneLength);
      world.entities.setVision({
        x: own.x,
        y: own.y,
        headingDegrees: own.rotation,
        circleRadius,
        coneLength,
      });
    } else if (this.socket) {
      // Versenkt: kein eigenes Boot, keine Sicht — die ganze See liegt im
      // Dunkeln, bis der Wiedereinstieg den nächsten Spawn bringt. Ohne das
      // bliebe die letzte Sicht-Ellipse irgendwo stehen.
      world.setVision(0, 0, 0, 0, 0);
    }

    // Reihenfolge ist zwingend: erst simulieren, dann die Ansichten nachziehen,
    // dann die Kamera folgen lassen, dann die Matrizen bauen. Andersherum folgt
    // die Kamera der Position des Vorframes und der nächste Rechtsklick rechnet
    // mit einer veralteten Matrix.
    world.update(frameSeconds);
    world.syncViews(frameSeconds);
    world.updateFollow(frameSeconds);
    world.applyCamera(app.screen.width, app.screen.height);

    // Ganz am Ende: die GUI liest denselben Zustand, der gerade gerendert wurde.
    writeHud(frameSeconds);
  }

  destroy(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.snapshots.length = 0;
    this.ownHp = null;
    this.ownAmmo = {};
    setSunkNotice(null);
    if (this.tiltKeys) window.removeEventListener('keydown', this.tiltKeys);
    this.tiltKeys = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.orders?.destroy();
    this.orders = null;
    this.camera?.destroy();
    this.camera = null;
    this.world?.destroy();
    this.world = null;
    this.app?.destroy(true, { children: true });
    this.app = null;
  }
}

/**
 * Linear zwischen zwei Serverzuständen — der Kurs über den kürzesten Weg,
 * sonst schlüge eine Wende über die 0°-Naht einmal quer durchs Ziffernblatt.
 */
function lerpState(a: PlayerState, b: PlayerState, t: number): PlayerState {
  return {
    id: b.id,
    name: b.name,
    // Diskrete Werte kommen aus dem NEUEREN Zustand — ein Modellwechsel
    // „interpoliert" nicht, er passiert.
    model: b.model,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    rotation: norm360(a.rotation + angleDelta(a.rotation, b.rotation) * t),
    speed: a.speed + (b.speed - a.speed) * t,
    depth: a.depth + (b.depth - a.depth) * t,
    periscope: a.periscope + (b.periscope - a.periscope) * t,
  };
}

/** Wie `lerpState`, nur für den schmalen Projektilzustand. */
function lerpProjectile(a: ProjectileState, b: ProjectileState, t: number): ProjectileState {
  return {
    id: b.id,
    model: b.model,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    rotation: norm360(a.rotation + angleDelta(a.rotation, b.rotation) * t),
  };
}
