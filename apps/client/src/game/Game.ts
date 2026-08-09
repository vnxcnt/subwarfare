import { Application } from 'pixi.js';
import { DEMO_TRAFFIC, DEMO_VESSEL, RENDERER, SIM, VESSEL_DEMO } from '../config';
import { writeHud } from '../state/hud';
import { CameraController } from './CameraController';
import { DemoTraffic } from './DemoTraffic';
import type { OwnStatePayload, StatePayload } from '@subwarfare/shared';
import { Vessel } from '@subwarfare/shared';
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
 * - **Offline** ist der bisherige Demobetrieb mit lokaler Simulation. Er
 *   bleibt erreichbar, weil er ohne jeden Server läuft — zum Entwickeln der
 *   Darstellung und als Vorführmodus.
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
  /** Kamera einmalig aufs eigene Boot setzen, sobald es im Broadcast steht. */
  private awaitingFirstSelf = false;

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
    this.awaitingFirstSelf = true;

    const socket = new GameSocket();
    this.socket = socket;

    socket.connect(session.gameUrl, session.ticket, {
      onWelcome: (payload) => {
        this.selfId = payload.selfId;
        world.setMap(payload.map);
      },
      onState: (payload) => this.applyStateBroadcast(payload),
      onOwn: (payload) => {
        this.pendingOwn = payload;
        this.ownVessel?.applyOwnState(payload);
      },
      onPlayerLeft: (id) => {
        if (id !== this.selfId) world.entities.remove(id);
      },
      onEnded: (message) => session.onEnded(message),
    });

    world.setZoom(0.55);
  }

  /**
   * Ein `state`-Broadcast: Abgleich statt Neuaufbau. Neue Kennungen spawnen,
   * bekannte übernehmen die Werte, verschwundene werden entfernt.
   */
  private applyStateBroadcast(payload: StatePayload): void {
    const world = this.world;
    if (!world) return;

    const seen = new Set<string>();
    for (const player of payload.players) {
      seen.add(player.id);
      const existing = world.entities.get(player.id);
      if (existing) {
        existing.applyState(player);
        continue;
      }

      const vessel = world.entities.spawn(
        new Vessel(
          { id: player.id, name: player.name, x: player.x, y: player.y, rotation: player.rotation },
          VESSEL_DEMO,
        ),
      );
      vessel.applyState(player);

      if (player.id === this.selfId) {
        // Der zwischengespeicherte Besitzer-Zustand gehört auf das frisch
        // gespawnte Boot — er kam möglicherweise vor diesem Broadcast an.
        if (this.pendingOwn) vessel.applyOwnState(this.pendingOwn);
        if (this.awaitingFirstSelf) {
          this.awaitingFirstSelf = false;
          world.centerOn(vessel.x, vessel.y);
          world.follow(vessel);
        }
      }
    }

    // Rückwärts unnötig — `remove` über eine Kopie der Kennungen.
    for (const vessel of [...world.entities.models()]) {
      if (!seen.has(vessel.id)) world.entities.remove(vessel.id);
    }
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
