import { Application } from 'pixi.js';
import { DEMO_TRAFFIC, DEMO_VESSEL, PEEK, RENDERER, SIM, VESSEL_DEMO, VISION } from '../config';
import { pushLogEntry, setSunkNotice, writeHud } from '../state/hud';
import { CameraController } from './CameraController';
import { DemoTraffic } from './DemoTraffic';
import type {
  ArmorState,
  CrateState,
  OwnStatePayload,
  PlayerState,
  ProjectileState,
  ShipStats,
  StatePayload,
  TubeState,
  VesselModel,
  WeaponId,
  WeatherState,
} from '@subwarfare/shared';
import {
  DAMAGE,
  DEFAULT_WEATHER,
  aimSpreadDeg,
  currentHour,
  DECOY,
  DEFAULT_SHIP_STATS,
  DEFAULT_VESSEL_MODEL,
  DESTROYER,
  GUN,
  SHIP_TYPE_SUBMARINE,
  DEPTH_CHARGE,
  SIDE_LAUNCH_HALF_ANGLE_DEG,
  TORPEDO,
  Vessel,
  angleDelta,
  applyPerksToProfile,
  clampStep,
  norm360,
  profileForShip,
  scaledHull,
  torusDelta,
} from '@subwarfare/shared';
import type { ExitPoint, RoutePoint } from '@subwarfare/shared';
import { GameSocket } from '../network/GameSocket';
import { keys, settingsModalOpen } from '../state/settings';
import { fxTextureCount, loadFxTextures } from './fx-textures';
import { preloadUiImages, uiImageCount } from './preload';
import { getTilt, setTilt } from './Projection';
import { GameAudio } from './sound';
import { loadVesselTextures, setModelSizes, vesselAtlasCount } from './textures';
import { World } from './World';
import { isTextEntry } from '../ui/dom';

/** Zugangsdaten für den Online-Betrieb — Ticket aus der Lobby. */
export interface OnlineSession {
  gameUrl: string;
  ticket: string;
  /** Wird gerufen, wenn die Partie endet — Rauswurf oder Verbindungsabriss. */
  onEnded: (message: string) => void;
  /** Erfolgreich extrahiert: `coins` sind gesichert, zurück ins Menü. */
  onExtracted: (coins: number) => void;
}

/** Stand des Ladevorgangs für den Ladebildschirm. */
export interface LoadProgress {
  /** Was gerade läuft — kurze Beschriftung. */
  label: string;
  /** Fortschritt über den GESAMTEN Beitritt, 0..1. */
  value: number;
}

/**
 * Rückmeldungen an die Ansicht während des Beitritts.
 *
 * Getrennt von `OnlineSession`, weil sie NICHTS mit der Verbindung zu tun
 * haben: auch der Offline-Betrieb lädt Grafiken und wird irgendwann fertig.
 */
export interface InitHooks {
  onProgress?: (progress: LoadProgress) => void;
  /**
   * Feuert, sobald das erste Bild MIT Inhalt gezeichnet ist — eigenes Boot in
   * der Welt, Ozean-Shader übersetzt. Erst dann darf der Ladebildschirm weg.
   */
  onReady?: () => void;
}

/**
 * Gewichte der Ladeabschnitte im Balken.
 *
 * Die Grafiken bekommen den Löwenanteil, weil sie die Zeit auch wirklich
 * verbrauchen (~7 MB). Renderer-Start und Verbindungsaufbau sind kurz, sollen
 * aber sichtbar etwas bewegen — ein Balken, der bei 0 klebt, sieht kaputt aus.
 */
const LADEN_RENDERER = 0.06;
const LADEN_GRAFIK = 0.82;

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
  private resizeObserver: ResizeObserver | null = null;
  private tiltKeys: ((event: KeyboardEvent) => void) | null = null;
  private traffic: DemoTraffic | null = null;
  private accumulator = 0;

  /** Handruder über A/D — gehaltene Tasten, zuletzt gesendete Ruderlage. */
  private steerListeners: {
    down: (event: KeyboardEvent) => void;
    up: (event: KeyboardEvent) => void;
    blur: () => void;
  } | null = null;
  private steerLeft = false;
  private steerRight = false;
  /**
   * PHYSISCHE Taste, die die jeweilige Ruderlage gesetzt hat. Das keyup muss
   * auch dann lösen, wenn die Belegung ZWISCHEN Drücken und Loslassen
   * geändert wurde (Einstellungen offen bei gehaltener Taste) — sonst bleibt
   * das Ruder liegen und das Boot fährt dauerhaft im Kreis.
   */
  private steerLeftCode: string | null = null;
  private steerRightCode: string | null = null;
  private sentSteer = 0;
  /** Unterdrückt das Browser-Kontextmenü auf dem Canvas (Rechtsklick tut nichts mehr). */
  private contextMenuBlocker: ((event: Event) => void) | null = null;

  /**
   * Zuletzt BEFOHLENE Telegrafenstufe, bis die Server-Bestätigung (`own`)
   * eintrifft — Basis für schnelle W/S-Folgen. Null = bestätigter Stand gilt.
   */
  private pendingTelegraphStep: number | null = null;

  /**
   * Waffen-Zielmodus (Q): Peilung zur Maus, sektorgebunden gefeuert. Nur für
   * Überwasserschiffe — U-Boote zielen nicht (Bugrohr voraus).
   */
  private aiming = false;
  /** Letzte Mausposition auf dem Canvas, in CSS-Pixeln. Null vor der ersten Bewegung. */
  private mouseScreen: { x: number; y: number } | null = null;
  private mouseMoveListener: ((event: PointerEvent) => void) | null = null;
  private mouseLeaveListener: (() => void) | null = null;
  /** Rechte Maustaste gehalten? Nur dann folgt der Blick dem Zeiger. */
  private peekHeld = false;
  private peekButtonListeners: {
    down: (event: PointerEvent) => void;
    up: (event: PointerEvent) => void;
  } | null = null;
  /** Pro Frame berechnete Zielpeilung in Kursgrad — null, wenn nicht zielbar. */
  private aimBearing: number | null = null;

  private socket: GameSocket | null = null;
  private selfId: string = DEMO_VESSEL.id;
  /** Angeklicktes fremdes Schiff — Ring + Namensschild. Null = keine Auswahl. */
  private selectedId: string | null = null;
  private audio: GameAudio | null = null;
  /**
   * Projektil-Kennungen des letzten Broadcasts. Eine NEUE Kennung neben einem
   * Schiff ist ein Abschuss — der Auslöser für den Abschussklang.
   */
  private previousProjectileIds = new Set<string>();
  /**
   * Abschussklänge sind erst scharf, wenn der VORIGE Broadcast das eigene
   * Boot enthielt. Beim Join und nach dem Respawn ist sonst jeder bereits
   * fliegende Torpedo „neu" und würde als Phantom-Abschuss knallen.
   */
  private launchSoundsArmed = false;
  /** Von destroy() gesetzt — bricht ein noch laufendes init() sauber ab. */
  private disposed = false;
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
  /**
   * Fertigmeldung an den Ladebildschirm — siehe `readySeen`/`readyFired` am
   * Ende von `step`.
   */
  private readyHook: (() => void) | null = null;
  private readySeen = false;
  private readyFired = false;
  /** Fortschrittsmeldung — auch nach `init` noch gebraucht (welcome). */
  private progressHook: ((progress: LoadProgress) => void) | null = null;
  private ownHp: number | null = null;
  /** Panzerung laut Server; null heißt ungepanzert ODER noch kein `own`. */
  private ownArmor: ArmorState | null = null;
  /** Getragener Loot in Coins — Fracht, gesichert erst nach der Extraktion. */
  private ownLoot = 0;
  /** Sekunden in der Extraktionszone laut Server; 0 außerhalb. */
  private ownExtractionSeconds = 0;
  private ownAmmo: Partial<Record<WeaponId, number>> = {};
  /** Rohr-Zustände laut Server — Quelle der Rohr-Anzeige. */
  private ownTubes: TubeState[] = [];
  /** Wetterlage der Karte (aus der `welcome`). */
  private weather: WeatherState = DEFAULT_WEATHER;
  /** Sekunden seit der Wetter-Übergabe — treibt die Tag/Nacht-Uhr. */
  private weatherSeconds = 0;

  /**
   * Schiffs-Basiswerte aus der `welcome` — die Zahlen, mit denen der Server
   * tatsächlich fährt. Anzeige-Wahrheit für Telegraf und Munitionsleiste.
   */
  private readonly shipCatalog = new Map<string, ShipStats>();
  /** Verbaute Perks des EIGENEN Boots (aus der `welcome`) — Profil-Spiegel. */
  private ownPerks: string[] = [];
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
    /** Kisten liegen still — der jüngste Stand reicht, nichts zu interpolieren. */
    crates: CrateState[];
  }> = [];
  /** Darstellungszeit in Server-Ticks (20/s), läuft dem Netz hinterher. */
  private renderTick = -1;
  private latestTick = -1;

  private static readonly TICKS_PER_SECOND = 1 / SIM.fixedDt;
  /** Render-Verzug in Ticks. 2,5 Ticks = 125 ms — überbrückt einen Paketverlust. */
  private static readonly DELAY_TICKS = 2.5;
  /**
   * Wie stark die Wiedergabe im TEMPO nachgezogen werden darf, um Rückstand
   * aufzuholen. 0,04 = ±4 %; darunter ist eine Tempoänderung nicht wahrnehmbar,
   * und ein ganzer Tick Rückstand ist trotzdem in gut einer Sekunde eingeholt.
   */
  private static readonly MAX_SPEED_TRIM = 0.04;

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

  /** Das angeklickte fremde Schiff — null ohne Auswahl oder nach Zielverlust. */
  get selectedVessel(): Vessel | null {
    if (!this.selectedId) return null;
    return this.world?.entities.get(this.selectedId) ?? null;
  }

  /** Steht die Auswahl gerade optisch in Sicht (Ring und Schild sichtbar)? */
  get selectedVisible(): boolean {
    return !!this.selectedId && !!this.world?.entities.sichtbar(this.selectedId);
  }

  /**
   * Klick-Selektion: das nächstgelegene fremde Schiff unter dem Zeiger. Die
   * Modelle tragen RENDER-Koordinaten im selben Raum wie `screenToWorld` —
   * ein einfacher Distanzvergleich genügt, kein Torus-Rechnen.
   */
  private selectAt(screenX: number, screenY: number): void {
    const world = this.world;
    if (!world) return;
    const punkt = world.screenToWorld(screenX, screenY);
    const zoom = world.camera.zoom;

    let treffer: string | null = null;
    let besteDistanz = Number.POSITIVE_INFINITY;
    for (const model of world.entities.models()) {
      if (model.id === this.selfId) continue;
      if (!world.entities.sichtbar(model.id)) continue;
      // Effektive Größe (ships.size) — derselbe Maßstab wie Billboard und
      // Server-Kollision.
      const dims = scaledHull(model.model, this.shipCatalog.get(model.model)?.size);
      // Klickradius: halbe Rumpflänge plus Griffweite — herausgezoomt hält
      // eine Mindestgröße in Bildschirmpixeln das Schiff treffbar.
      const radius = Math.max(dims.length * 0.62, 22 / zoom);
      const distanz = Math.hypot(model.x - punkt.x, model.y - punkt.y);
      if (distanz <= radius && distanz < besteDistanz) {
        besteDistanz = distanz;
        treffer = model.id;
      }
    }

    // Klick ins Leere hebt die Auswahl auf — wie beim Vorbild.
    this.selectedId = treffer;
    world.entities.setSelectedId(treffer);
  }

  /** Basiswerte eines Modells — Katalog vom Server, sonst die shared-Defaults. */
  shipStats(model: string): ShipStats {
    return (
      this.shipCatalog.get(model) ??
      DEFAULT_SHIP_STATS[model as VesselModel] ??
      DEFAULT_SHIP_STATS.fregatte01
    );
  }

  /**
   * Hält das Fahrprofil eines Fahrzeugs auf dem Stand seines Modells — und
   * spiegelt beim EIGENEN Boot die Schadens-Drossel des Servers, damit die
   * Telegraf-Anzeige (Höchstfahrt, befohlene Fahrt) dieselbe Wahrheit zeigt,
   * mit der der Server tatsächlich fährt.
   */
  private ensureProfile(vessel: Vessel): void {
    const stats = this.shipStats(vessel.model);
    const istEigenes = vessel.id === this.selfId;
    const throttled =
      istEigenes &&
      this.ownHp !== null &&
      this.ownHp > 0 &&
      this.ownHp < stats.hp * DAMAGE.slowHpRatio;

    // Perk-Signatur in den Cache-Schlüssel: kommt die welcome (mit den Perks)
    // nach dem ersten Profil-Aufbau an, zieht das Profil hier nach.
    const perkKey = istEigenes ? this.ownPerks.join(',') : '';
    const key = `${vessel.model}:${throttled ? 'gedrosselt' : 'voll'}:${perkKey}`;
    if (this.appliedProfileModel.get(vessel.id) === key) return;

    // Beim eigenen Boot dieselbe Rechnung wie der Server: erst Perks aufs
    // Basisprofil, dann gegebenenfalls die Schadens-Drossel obendrauf.
    let base = profileForShip(DESTROYER, stats);
    if (istEigenes && this.ownPerks.length > 0) {
      base = applyPerksToProfile(base, this.ownPerks);
    }
    vessel.applyProfile(
      throttled
        ? {
            ...base,
            maxForward: base.maxForward * DAMAGE.slowFactor,
            maxReverse: base.maxReverse * DAMAGE.slowFactor,
          }
        : base,
    );
    this.appliedProfileModel.set(vessel.id, key);
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

  async init(
    host: HTMLElement,
    session: OnlineSession | null = null,
    hooks: InitHooks = {},
  ): Promise<void> {
    if (this.app) return;
    this.disposed = false;
    this.readyHook = hooks.onReady ?? null;
    this.progressHook = hooks.onProgress ?? null;
    const melden = hooks.onProgress ?? ((): void => {});
    melden({ label: 'Renderer wird gestartet', value: 0 });

    const app = new Application();
    await app.init({
      resizeTo: host,
      background: RENDERER.backgroundColor,
      antialias: RENDERER.antialias,
      preference: RENDERER.preference,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, RENDERER.maxResolution),
    });

    // destroy() kann während des awaits gelaufen sein (HMR, schneller
    // Routenwechsel). `this.app` war da noch null — hier selbst aufräumen,
    // sonst baut init() ein Zombie-Spiel an einen unmounteten Host.
    if (this.disposed) {
      app.destroy(true, { children: true });
      return;
    }

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
    // Textur zu und fiele sonst auf das Vektorpolygon zurück. Die Effekt-
    // Grafiken hängen mit dran: Kielwasser und Rauch fragen sie jeden Frame
    // synchron ab und zeichnen ohne sie schlicht nichts.
    melden({ label: 'Grafiken werden geladen', value: LADEN_RENDERER });

    /*
     * Ein gemeinsamer Zähler über ALLE drei Quellen: Schiffsatlanten,
     * Effektgrafiken und die Rahmen des HUD. Getrennte Balken wären ehrlicher
     * zur Technik, aber der Spieler will einen Balken sehen, der einmal von
     * links nach rechts läuft.
     */
    const gesamt = vesselAtlasCount() + fxTextureCount() + uiImageCount();
    const stand = new Map<string, number>();
    const schritt = (quelle: string) => (fertig: number): void => {
      stand.set(quelle, fertig);
      let summe = 0;
      for (const wert of stand.values()) summe += wert;
      melden({
        label: 'Grafiken werden geladen',
        value: LADEN_RENDERER + (summe / gesamt) * LADEN_GRAFIK,
      });
    };

    await Promise.all([
      loadVesselTextures(schritt('schiffe')),
      loadFxTextures(schritt('effekte')),
      // Die HUD-Rahmen liefen früher gar nicht über das Laden, sondern
      // trudelten während der ersten Sekunden im Gefecht ein.
      preloadUiImages(schritt('anzeige')),
    ]);

    // Lief destroy() während des Texturladens, hat es `this.app` (oben schon
    // gesetzt) bereits abgeräumt — hier nur noch aussteigen.
    if (this.disposed) return;
    melden({ label: 'Verbindung zum Gefecht', value: LADEN_RENDERER + LADEN_GRAFIK });

    // Klang lädt nebenher — bis die Puffer da sind, schweigt er einfach.
    // Ohne Klang bleibt das Spiel voll spielbar, deshalb nur eine Warnung.
    this.audio = new GameAudio();
    this.audio.init().catch((error) => {
      console.warn('[client] Spielklang nicht ladbar — es bleibt still:', error);
    });

    const world = new World();
    app.stage.addChild(world.container);
    this.world = world;

    if (session) this.initOnline(session);
    else this.initOffline();

    world.applyCamera(app.screen.width, app.screen.height);

    this.camera = new CameraController(app.canvas, world);

    // Rechtsklick steuert seit Protokoll v6 nichts mehr — aber das Browser-
    // Kontextmenü über der Karte wäre trotzdem nur im Weg.
    this.contextMenuBlocker = (event: Event) => event.preventDefault();
    app.canvas.addEventListener('contextmenu', this.contextMenuBlocker);

    // Mausposition für den Zielmodus — pointermove statt mousemove, damit
    // auch Stifte/Touchpads zählen. Nur merken, gerechnet wird pro Frame.
    this.mouseMoveListener = (event: PointerEvent) => {
      const rect = app.canvas.getBoundingClientRect();
      this.mouseScreen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    app.canvas.addEventListener('pointermove', this.mouseMoveListener);

    // Zeiger raus aus der Karte (Anzeige, Fensterrand): Blick zurück in die
    // Mitte. Ohne das bliebe der Versatz stehen, wo der Zeiger die Fläche
    // verlassen hat — das Bild hinge dann schief, ohne dass etwas passiert.
    this.mouseLeaveListener = () => {
      this.mouseScreen = null;
      this.peekHeld = false;
    };
    app.canvas.addEventListener('pointerleave', this.mouseLeaveListener);

    // Umschau-Taste: rechte Maustaste halten. `pointerup` hängt am FENSTER,
    // nicht am Canvas — wer über einem Anzeigefeld loslässt, soll trotzdem
    // zurückfokussieren. Das Kontextmenü ist oben ohnehin unterdrückt.
    // Linksklick: fremdes Schiff anklicken = auswählen (Ring + Namensschild),
    // Klick ins Leere = Auswahl aufheben.
    this.peekButtonListeners = {
      down: (event: PointerEvent) => {
        if (event.button === 2) this.peekHeld = true;
        else if (event.button === 0) {
          const rect = app.canvas.getBoundingClientRect();
          this.selectAt(event.clientX - rect.left, event.clientY - rect.top);
        }
      },
      up: (event: PointerEvent) => {
        if (event.button === 2) this.peekHeld = false;
      },
    };
    app.canvas.addEventListener('pointerdown', this.peekButtonListeners.down);
    window.addEventListener('pointerup', this.peekButtonListeners.up);

    this.attachSteering();

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
        // Angemeldet — es fehlt nur noch der erste Lagebericht.
        this.progressHook?.({ label: 'Lage wird übernommen', value: 0.96 });
        this.selfId = payload.selfId;
        world.entities.setOwnId(payload.selfId);
        // Eigene Perks — ensureProfile spiegelt damit das Server-Fahrprofil.
        this.ownPerks = payload.perks ?? [];
        for (const ship of payload.ships) this.shipCatalog.set(ship.model, ship);
        // Größenfaktoren an die Billboards — dieselben Werte, mit denen der
        // Server kollidiert.
        setModelSizes(payload.ships);
        world.setMap(payload.map);
        // Extraktionszonen sichtbar machen: je Kreis ein Ring aus Bojen.
        world.entities.setBuoys(payload.map.exitPoints);
        // Wetter kommt vom Server. Die Uhr läuft ab hier client-seitig weiter
        // (siehe `weatherSeconds`) — dafür muss nichts nachgeschickt werden.
        this.weather = payload.weather ?? DEFAULT_WEATHER;
        this.weatherSeconds = 0;
        world.setWeather(this.weather, this.weather.timeOfDay);
      },
      onWeather: (payload) => {
        // Wetterwechsel zur Laufzeit: die Uhr beginnt bei der neuen Zeit neu,
        // sonst spränge sie um die bisher verstrichenen Sekunden weiter.
        this.weather = payload;
        this.weatherSeconds = 0;
        world.setWeather(payload, payload.timeOfDay);
      },
      onState: (payload) => this.ingestState(payload),
      onOwn: (payload) => {
        this.pendingOwn = payload;
        this.ownHp = payload.hp;
        this.ownArmor = payload.armor ?? null;
        this.ownAmmo = payload.ammo;
        this.ownTubes = payload.tubes ?? [];
        // Gestiegene Fracht heißt: gerade eine Kiste geborgen. Nur der
        // ANSTIEG klingt — Tod und Extraktion setzen die Fracht auf null,
        // und das ist kein Beutemoment.
        if ((payload.loot ?? 0) > this.ownLoot) this.audio?.playLoot();
        this.ownLoot = payload.loot ?? 0;
        this.ownExtractionSeconds = payload.extractionSeconds ?? 0;
        // Bestätigter Stand übernimmt — die optimistische Stufe hat gedient.
        this.pendingTelegraphStep = null;
        this.ownVessel?.applyOwnState(payload);
      },
      onPlayerLeft: (id) => {
        if (id !== this.selfId) world.entities.remove(id);
      },
      onFx: (payload) => {
        // Effekt-Koordinaten kommen in Server-Lage — in die kameranahe
        // Torus-Kopie rücken, sonst explodiert es eine Kartenlänge entfernt.
        const karte = world.currentMap;
        const fxX = this.nearestWrap(payload.x, world.camera.x, karte.width);
        const fxY = this.nearestWrap(payload.y, world.camera.y, karte.height);
        world.spawnImpact(fxX, fxY, payload.kind === 'sunk');
        // Klang NUR für 'impact': der tödliche Treffer schickt impact UND
        // sunk im selben Tick — zweimal derselbe Knall wäre ein Doppelklang.
        // 'sunk' bleibt (vorerst) rein visuell.
        if (payload.kind !== 'impact') return;
        // Hörer-Position: das eigene Boot, sonst die Kamera. Die steht beim
        // eigenen Wrack (der eigene Untergang bleibt laut), aber ein fremder
        // Einschlag kilometerweit weg bleibt auch im Respawn-Fenster leise —
        // Distanz 0 als Fallback wäre ein Vollknall aus 4 km.
        const listener = this.ownVessel ?? world.camera;
        this.audio?.playImpact(Math.hypot(fxX - listener.x, fxY - listener.y));
      },
      onDestroyed: () => {
        // Versenkung = Rundenende: der Server trennt gleich, die Anzeige
        // überbrückt die letzten anderthalb Sekunden auf See.
        setSunkNotice(true);
      },
      onExtracted: (payload) => session.onExtracted(payload.coins),
      onLog: (payload) => pushLogEntry(payload.kind, payload.text),
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
  /**
   * ENDLOS-KARTE: rückt einen Server-Wert auf die Torus-Kopie, die dem Anker
   * (in der Regel der Kamera) am nächsten liegt. Alles Sichtbare landet damit
   * in einer zusammenhängenden RENDER-Ebene um die Kamera — auch wenn es in
   * Server-Koordinaten jenseits der Naht liegt.
   */
  private nearestWrap(value: number, anchor: number, size: number): number {
    return size > 0 ? anchor + torusDelta(anchor, value, size) : value;
  }

  /** Karten-Info für Anzeigen (Minimap): Maße, Extraktionszonen, Frachtroute. */
  get mapInfo(): {
    width: number;
    height: number;
    exits: ExitPoint[];
    route: RoutePoint[];
  } | null {
    const map = this.world?.currentMap;
    return map
      ? {
          width: map.width,
          height: map.height,
          exits: [...map.exitPoints],
          route: map.route ? [...map.route] : [],
        }
      : null;
  }

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
      crates: payload.crates ?? [],
    });
    // Deckel: getrimmt wird sonst nur im Ticker (`applyInterpolated`), und der
    // steht bei verborgenem Tab still — die 20 Hz kämen trotzdem weiter an.
    while (this.snapshots.length > 40) this.snapshots.shift();
    if (this.renderTick < 0) this.renderTick = payload.tick - Game.DELAY_TICKS;

    this.detectLaunches(payload);

    const seen = new Set<string>();
    const karte = world.currentMap;
    for (const player of payload.players) {
      seen.add(player.id);
      if (world.entities.get(player.id)) continue;

      // Frisch gesichtete Fahrzeuge kommen in Server-Koordinaten — für die
      // Darstellung in die Torus-Kopie nächst der Kamera gerückt.
      const wx = this.nearestWrap(player.x, world.camera.x, karte.width);
      const wy = this.nearestWrap(player.y, world.camera.y, karte.height);
      const vessel = world.entities.spawn(
        new Vessel(
          {
            id: player.id,
            name: player.name,
            model: player.model,
            x: wx,
            y: wy,
            rotation: player.rotation,
          },
          profileForShip(DESTROYER, this.shipStats(player.model)),
        ),
      );
      this.appliedProfileModel.set(player.id, player.model);
      vessel.applyState({ ...player, x: wx, y: wy });

      if (player.id === this.selfId) {
        // Der zwischengespeicherte Besitzer-Zustand gehört auf das frisch
        // gespawnte Boot — er kam möglicherweise vor diesem Broadcast an.
        if (this.pendingOwn) vessel.applyOwnState(this.pendingOwn);
        // Bei JEDEM Selbst-Spawn zentrieren und folgen — beim ersten Betreten
        // genauso wie beim Wiedereinstieg nach einer Versenkung (das alte
        // Follow-Ziel ist dann ein verwaistes Objekt).
        world.centerOn(vessel.x, vessel.y);
        world.follow(vessel);
        setSunkNotice(false);
        // Ruderlage neu ansagen: das frische Server-Boot steht mittschiffs,
        // die gehaltene Taste soll sofort wieder greifen.
        this.pushSteer(true);
      }
    }

    // Rückwärts unnötig — `remove` über eine Kopie der Kennungen.
    for (const vessel of [...world.entities.models()]) {
      if (!seen.has(vessel.id)) world.entities.remove(vessel.id);
    }
  }

  /**
   * Abschusserkennung fürs Gehör: eine Projektil-Kennung, die es im vorigen
   * Broadcast noch nicht gab UND die neben einem Schiff auftaucht, ist ein
   * Abschuss. Die Nähe-Prüfung ist nötig, weil ein Torpedo auch mitten im
   * Flug in die eigene Sonar-Reichweite einlaufen kann — der hat seinen
   * Abschussknall woanders gehabt. Der Typ des nächsten Schiffs entscheidet,
   * ob es nach U-Boot- oder Schiffsrohr klingt.
   */
  private detectLaunches(payload: StatePayload): void {
    const current = new Set<string>();
    for (const projectile of payload.projectiles ?? []) {
      current.add(projectile.id);
      if (this.previousProjectileIds.has(projectile.id)) continue;
      // Nicht scharf (Join, Tod, erster Broadcast nach Respawn): nur den
      // Bestand aufnehmen — diese Torpedos wurden irgendwann früher gefeuert.
      if (!this.launchSoundsArmed) continue;

      // Beide Positionen liegen in Server-Koordinaten — die Distanz muss
      // trotzdem über den Torus laufen (Abschuss direkt hinter der Naht).
      const karte = this.world?.currentMap;
      let closest: PlayerState | null = null;
      let best = Number.POSITIVE_INFINITY;
      for (const player of payload.players) {
        const d = karte
          ? Math.hypot(
              torusDelta(player.x, projectile.x, karte.width),
              torusDelta(player.y, projectile.y, karte.height),
            )
          : Math.hypot(projectile.x - player.x, projectile.y - player.y);
        if (d < best) {
          best = d;
          closest = player;
        }
      }
      // Täuschkörper bleiben leise (Gegenmaßnahme, kein Alarm) — Torpedo,
      // Geschütz und Wasserbombe haben je ihren eigenen Abschussklang.
      if (
        projectile.model !== TORPEDO.model &&
        projectile.model !== GUN.model &&
        projectile.model !== DEPTH_CHARGE.model
      ) {
        continue;
      }

      // Abschussoffset liegt bei ~75 m plus ein Broadcast-Intervall Flugweg.
      if (closest && best < 200) {
        const own = this.ownVessel;
        // Eigenes Boot liegt in RENDER-Koordinaten (evtl. jenseits der Naht)
        // — torusDelta verkraftet beide Lagen.
        const distance =
          own && karte
            ? Math.hypot(
                torusDelta(own.x, projectile.x, karte.width),
                torusDelta(own.y, projectile.y, karte.height),
              )
            : 0;
        if (projectile.model === GUN.model) {
          this.audio?.playGunFire(distance);
        } else if (projectile.model === DEPTH_CHARGE.model) {
          // Der Abwurf klingt wie der eines Überwasserschiffs — es IST einer.
          this.audio?.playFire(false, distance);
        } else {
          this.audio?.playFire(
            this.shipStats(closest.model).type === SHIP_TYPE_SUBMARINE,
            distance,
          );
        }
      }
    }
    this.previousProjectileIds = current;
    // Scharf erst ab dem Broadcast NACH einem mit eigenem Boot — deckt Join,
    // Versenkung (leere Zustände) und den ersten Respawn-Broadcast ab.
    this.launchSoundsArmed = payload.players.some((player) => player.id === this.selfId);
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

    const target = this.latestTick - Game.DELAY_TICKS;
    const drift = target - this.renderTick;
    if (Math.abs(drift) > 10) {
      // Großer Aussetzer (verborgener Tab): hart aufschnappen, sanft aufholen
      // dauerte hier Minuten.
      this.renderTick = target;
    } else {
      /*
       * ⚠️ Die Nachführung MUSS im Tempo begrenzt sein.
       *
       * Vorher stand hier "renderTick += drift * min(1, frameSeconds * 3)"
       * ZUSÄTZLICH zum Echtzeitschritt. Das effektive Wiedergabetempo war damit
       * 20 + 3·drift Ticks/s — ohne jede Grenze. `latestTick` springt aber
       * paketweise, also sägt drift dauerhaft zwischen etwa −1 und +1, und die
       * ganze Welt lief permanent zwischen 17 und 23 Ticks pro Sekunde. Das ist
       * kein Ausreißer nach einem Paketverlust, sondern der Normalbetrieb — und
       * genau das nimmt man als Ruckeln wahr.
       *
       * Jetzt läuft die Uhr in Echtzeit und wird nur um höchstens ±4 % im TEMPO
       * nachgezogen. Ein ganzer Tick Rückstand ist damit nach gut einer Sekunde
       * eingeholt, ohne dass die Bewegung sichtbar schneller oder langsamer wird
       * (unter ~5 % ist eine Tempoänderung nicht wahrnehmbar).
       */
      const tempo = Math.max(-Game.MAX_SPEED_TRIM, Math.min(Game.MAX_SPEED_TRIM, drift * 0.25));
      this.renderTick += frameSeconds * Game.TICKS_PER_SECOND * (1 + tempo);
    }

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

    const karte = world.currentMap;
    const cam = world.camera;
    for (const vessel of world.entities.models()) {
      const a = older.byId.get(vessel.id);
      const bRoh = newer.byId.get(vessel.id);
      // Torus: den neueren Zustand an den älteren HERANRÜCKEN, bevor
      // interpoliert wird — sonst schwenkte eine Nahtquerung einmal quer
      // über die ganze Karte.
      const b =
        a && bRoh
          ? {
              ...bRoh,
              x: a.x + torusDelta(a.x, bRoh.x, karte.width),
              y: a.y + torusDelta(a.y, bRoh.y, karte.height),
            }
          : bRoh;
      // Frisch gespawnt oder kurz vor dem Entfernen: den vorhandenen Stand
      // halten statt zwischen Lücken zu raten.
      const state = a && b ? lerpState(a, b, t) : (b ?? a);
      if (state) {
        // In die RENDER-Kopie nächst der Kamera: Fahrzeuge hinter der Naht
        // erscheinen auf der nahen Seite, und das eigene Boot läuft ohne
        // Sprung über die Naht hinaus (die Kamera folgt, das Rebase holt
        // später alles gemeinsam zurück).
        vessel.applyState({
          ...state,
          x: this.nearestWrap(state.x, cam.x, karte.width),
          y: this.nearestWrap(state.y, cam.y, karte.height),
        });
        // Modellwechsel (Dev-Menü) bringt neue Fahrwerte mit — fürs HUD
        // (Telegraf-Höchstfahrt) muss das Profil mitziehen.
        this.ensureProfile(vessel);
      }
    }

    // Projektile: Bestand aus dem NEUEREN Snapshot (wer dort fehlt, ist
    // eingeschlagen oder abgelaufen), Bewegung zwischen beiden interpoliert —
    // mit derselben Torus-Behandlung wie die Fahrzeuge.
    const projectiles: ProjectileState[] = [];
    for (const [id, bRoh] of newer.projectiles) {
      const a = older.projectiles.get(id);
      const b = a
        ? {
            ...bRoh,
            x: a.x + torusDelta(a.x, bRoh.x, karte.width),
            y: a.y + torusDelta(a.y, bRoh.y, karte.height),
          }
        : bRoh;
      const p = a ? lerpProjectile(a, b, t) : b;
      projectiles.push({
        ...p,
        x: this.nearestWrap(p.x, cam.x, karte.width),
        y: this.nearestWrap(p.y, cam.y, karte.height),
      });
    }
    world.entities.applyProjectiles(projectiles);

    // Kisten aus dem NEUEREN Snapshot: sie bewegen sich nicht, und wer fehlt,
    // ist eingesammelt — die Ansicht soll das sofort zeigen. Auch sie in die
    // kameranahe Torus-Kopie.
    world.entities.applyCrates(
      newer.crates.map((c) => ({
        ...c,
        x: this.nearestWrap(c.x, cam.x, karte.width),
        y: this.nearestWrap(c.y, cam.y, karte.height),
      })),
    );
  }

  /* --- Befehle -------------------------------------------------------- */

  /**
   * Handruder auf A (Backbord) und D (Steuerbord). Gehaltene Tasten werden zu
   * einer Ruderlage −1/0/1 verrechnet, gesendet wird NUR bei Änderung — nicht
   * pro Frame und nicht pro Auto-Repeat.
   */
  private attachSteering(): void {
    // Belegung LIVE aus den Einstellungen lesen — nicht beim Anhängen
    // einfrieren, sonst wirkt eine Umbelegung erst nach Kartenwechsel.
    const down = (event: KeyboardEvent): void => {
      // Offenes Einstellungs-Panel: Drücken wirkt nicht (Loslassen unten
      // schon — eine gehaltene Taste muss immer lösen können).
      if (isTextEntry(event.target) || event.repeat || settingsModalOpen.value) return;
      if (event.code === keys.value.steerLeft) {
        this.steerLeft = true;
        this.steerLeftCode = event.code;
      } else if (event.code === keys.value.steerRight) {
        this.steerRight = true;
        this.steerRightCode = event.code;
      } else if (event.code === keys.value.aimToggle) {
        this.toggleAiming();
        event.preventDefault();
        return;
      } else return;
      this.pushSteer();
      event.preventDefault();
    };
    const up = (event: KeyboardEvent): void => {
      // Auch gegen die MERKTE physische Taste prüfen — die Belegung kann sich
      // zwischen Drücken und Loslassen geändert haben.
      if (event.code === keys.value.steerLeft || event.code === this.steerLeftCode) {
        this.steerLeft = false;
        this.steerLeftCode = null;
      } else if (event.code === keys.value.steerRight || event.code === this.steerRightCode) {
        this.steerRight = false;
        this.steerRightCode = null;
      } else return;
      this.pushSteer();
    };
    // Fensterwechsel mit gehaltener Taste: das keyup kommt nie an — ohne den
    // Reset liefe das Boot ewig im Kreis.
    const blur = (): void => {
      this.steerLeft = false;
      this.steerRight = false;
      this.steerLeftCode = null;
      this.steerRightCode = null;
      this.pushSteer();
    };

    this.steerListeners = { down, up, blur };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
  }

  /**
   * Ruderlage aus den gehaltenen Tasten senden — normal nur bei Änderung.
   * `force` erzwingt den Send: nach Versenkung/Respawn spawnt der Server ein
   * frisches Boot mit Ruder mittschiffs, während `sentSteer` noch den alten
   * Wert hält — ohne Resync führe das Boot trotz gehaltener Taste geradeaus.
   */
  private pushSteer(force = false): void {
    const value = (this.steerRight ? 1 : 0) - (this.steerLeft ? 1 : 0);
    if (!force && value === this.sentSteer) return;
    this.sentSteer = value;
    if (this.socket) this.socket.sendSteer(value);
    else this.ownVessel?.setSteer(value);
  }

  /* --- Zielmodus ------------------------------------------------------- */

  /** Ob das eigene Boot überhaupt zielt — U-Boote haben keinen Zielmodus. */
  private ownAimsWithMouse(): boolean {
    const own = this.ownVessel;
    return !!own && this.shipStats(own.model).type !== SHIP_TYPE_SUBMARINE;
  }

  /**
   * Blickversatz aus der Mausposition — der Kern der Umschau-Mechanik.
   *
   * Der Zeiger wird auf −1..1 je Achse normiert, um eine runde Totzone
   * beschnitten und auf die halbe Fensterkante mal `PEEK.strength` skaliert.
   * Ohne Zeiger auf der Fläche (nie bewegt, Fenster verlassen) ist das Ziel
   * die Mitte — der Versatz läuft dann von selbst zurück.
   */
  private updatePeek(width: number, height: number): void {
    const world = this.world;
    if (!world) return;

    // Umgeschaut wird NUR mit gehaltener rechter Maustaste — loslassen holt
    // den Blick zurück aufs Boot. Ohne das Gate wanderte das Bild bei jeder
    // Mausbewegung mit, auch wenn man nur zielen oder klicken wollte.
    const maus = this.peekHeld ? this.mouseScreen : null;
    if (!maus) {
      world.setPeekTarget(0, 0);
      return;
    }

    const halbeBreite = width / 2;
    const halbeHoehe = height / 2;
    if (halbeBreite <= 0 || halbeHoehe <= 0) return;

    const nx = (maus.x - halbeBreite) / halbeBreite;
    const ny = (maus.y - halbeHoehe) / halbeHoehe;
    const laenge = Math.hypot(nx, ny);
    if (laenge <= PEEK.deadzone) {
      world.setPeekTarget(0, 0);
      return;
    }

    // Radial nachskaliert: direkt hinter der Totzone beginnt der Versatz bei 0
    // und erreicht am Rand den vollen Wert. Ein harter Sprung an der
    // Totzonengrenze wäre genau das Ruckeln, das sie verhindern soll.
    const gekappt = Math.min(laenge, 1);
    const anteil = (gekappt - PEEK.deadzone) / (1 - PEEK.deadzone) / laenge;

    /*
     * EIN Bezugsmaß für beide Achsen — die halbe längere Fensterkante.
     *
     * Genommen wird die Zeigerauslenkung weiter je Achse (oben am Rand heißt
     * voll ausgelenkt, egal wie flach das Fenster ist), aber das Ergebnis
     * skaliert für x und y gleich. Mit der jeweils eigenen Kante reichte der
     * Blick nach oben und unten bei 16:9 nur gut halb so weit wie zur Seite,
     * obwohl die Fahrtrichtung genauso oft nach Norden zeigt.
     */
    const bezug = Math.max(halbeBreite, halbeHoehe) * PEEK.strength;
    // Senkrecht gedeckelt: auf sehr breiten Fenstern überstiege das Bezugsmaß
    // die kurze Höhe, und das Boot rutschte unter die Gefechtsleiste. Auf 16:9
    // greift der Deckel nicht — dort bleibt der Blick in alle Richtungen gleich
    // weit.
    const bezugY = Math.min(bezug, halbeHoehe * PEEK.verticalCap);
    world.setPeekTarget(nx * anteil * bezug, ny * anteil * bezugY);
  }

  /**
   * Q schaltet den Zielmodus. Die Kamera hängt ohnehin am eigenen Boot — hier
   * ist nur noch das Aufräumen der Ziellinie zu erledigen.
   */
  private toggleAiming(): void {
    if (!this.ownAimsWithMouse()) return;
    this.aiming = !this.aiming;
    if (!this.aiming) {
      this.world?.setAimLine(null);
      this.aimBearing = null;
    }
  }

  /**
   * Pro Frame: Peilung zur Maus bestimmen, Ziellinie zeichnen. Grün in einem
   * gültigen Feuersektor (Bug fürs Geschütz, Seiten für Torpedo/Täuschkörper —
   * je nachdem, was das Schiff führt), sonst rot.
   */
  private updateAiming(): void {
    const world = this.world;
    if (!world) return;

    // Der Zielmodus ERLISCHT, wenn das Boot ihn nicht mehr kann — Wechsel auf
    // ein U-Boot oder Versenkung. Sonst bliebe das Flag hängen: Q wäre als
    // U-Boot wirkungslos (Guard) und nach Respawn/Rückwechsel wäre der Modus
    // ungefragt wieder aktiv, mit invertierter Q-Semantik.
    if (this.aiming && !this.ownAimsWithMouse()) {
      this.aiming = false;
    }

    const own = this.ownVessel;
    if (!this.aiming || !own || !this.mouseScreen) {
      if (this.aimBearing !== null) {
        world.setAimLine(null);
        this.aimBearing = null;
      }
      return;
    }

    const target = world.screenToWorld(this.mouseScreen.x, this.mouseScreen.y);
    const dx = target.x - own.x;
    const dy = target.y - own.y;
    // Totzone direkt überm eigenen Boot: keine sinnvolle Peilung. Linie UND
    // Peilung löschen — stehen lassen fröre beide auf altem Stand ein (die
    // Kamera folgt dem Boot, der Punkt unter der ruhenden Maus wandert mit).
    if (Math.hypot(dx, dy) < 1) {
      world.setAimLine(null);
      this.aimBearing = null;
      return;
    }

    const bearing = norm360((Math.atan2(dx, -dy) * 180) / Math.PI);
    this.aimBearing = bearing;

    const armament = this.shipStats(own.model).armament;
    const offset = angleDelta(own.rotation, bearing);
    const inBow = armament.includes('geschuetz') && Math.abs(offset) <= GUN.arcHalfAngleDeg;
    const inSide =
      (armament.includes('torpedo') || armament.includes('taeuschkoerper')) &&
      Math.abs(Math.abs(offset) - 90) <= SIDE_LAUNCH_HALF_ANGLE_DEG;
    const inAft =
      armament.includes('wasserbombe') &&
      180 - Math.abs(offset) <= DEPTH_CHARGE.arcHalfAngleDeg;

    world.setAimLine({
      x0: own.x,
      y0: own.y,
      x1: target.x,
      y1: target.y,
      valid: inBow || inSide || inAft,
      // Derselbe Wert, mit dem der Server gleich würfelt — die Anzeige lügt
      // nicht über die eigene Treffwahrscheinlichkeit.
      spreadDeg: aimSpreadDeg(this.weather.seaState, own.depth),
    });
  }

  /** Peilung, wenn sie für DIESE Waffe im gültigen Sektor liegt — sonst null. */
  private aimFor(weapon: WeaponId): number | null {
    const own = this.ownVessel;
    if (!this.aiming || !own || this.aimBearing === null) return null;
    const offset = angleDelta(own.rotation, this.aimBearing);
    if (weapon === 'geschuetz') {
      return Math.abs(offset) <= GUN.arcHalfAngleDeg ? this.aimBearing : null;
    }
    if (weapon === 'wasserbombe') {
      // Achteraus-Sektor: 180 − |offset| ist der Abstand zu „dead astern".
      return 180 - Math.abs(offset) <= DEPTH_CHARGE.arcHalfAngleDeg ? this.aimBearing : null;
    }
    return Math.abs(Math.abs(offset) - 90) <= SIDE_LAUNCH_HALF_ANGLE_DEG ? this.aimBearing : null;
  }

  orderTelegraph(step: number): void {
    const clamped = clampStep(step);
    // Optimistische Basis für nudgeTelegraph — siehe dort.
    this.pendingTelegraphStep = clamped;
    if (this.socket) {
      this.socket.sendTelegraph(clamped);
      return;
    }
    this.ownVessel?.setTelegraph(clamped);
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
   * U-Boote feuern ungerichtet (Bugrohr/achtern). Überwasserschiffe brauchen
   * den Zielmodus (Q) und eine Peilung im gültigen Sektor — sonst fällt kein
   * Schuss (die rote Linie zeigt warum). Der Server prüft dasselbe noch mal.
   */
  orderFire(weapon: WeaponId): void {
    if (!this.socket) return;
    if (!this.ownAimsWithMouse()) {
      this.socket.sendFire(weapon);
      return;
    }
    const bearing = this.aimFor(weapon);
    if (bearing === null) return;
    this.socket.sendFire(weapon, bearing);
  }

  /** Eigene Lebenspunkte laut Server; null, solange kein `own` ankam. */
  get hp(): number | null {
    return this.ownHp;
  }

  /**
   * Panzerung dieses Einsatzes laut Server. `null` heißt ungepanzert — die
   * Anzeige blendet ihre Leiste dann aus, statt 0 % zu behaupten.
   */
  get armor(): ArmorState | null {
    return this.ownArmor;
  }

  /**
   * Munition an Bord laut Server, je Waffe.
   *
   * Enthält NUR die Waffen, die dieser Einsatz wirklich dabei hat — ein
   * fehlender Schlüssel heißt „nicht an Bord" und ist etwas anderes als 0.
   * Vor dem ersten `own` ist die Sammlung leer; die Gefechtsleiste zeigt dann
   * kurz keine Waffe, was ehrlicher ist als eine geratene Kapazität.
   */
  ammoAboard(): Partial<Record<WeaponId, number>> {
    return this.ownAmmo;
  }

  /** Getragener Loot in Coins laut Server. */
  get loot(): number {
    return this.ownLoot;
  }

  /** Sekunden ununterbrochen in der Extraktionszone; 0 außerhalb. */
  get extractionSeconds(): number {
    return this.ownExtractionSeconds;
  }

  /** Rohr-Zustände laut Server. Leer bei Schiffen ohne Torpedorohre. */
  tubes(): TubeState[] {
    return this.ownTubes;
  }

  /** Wetterlage der Karte samt aktueller Uhrzeit — für die Anzeige. */
  weatherNow(): { weather: WeatherState; hour: number } {
    return { weather: this.weather, hour: currentHour(this.weather, this.weatherSeconds) };
  }

  /**
   * Entwickler-Befehl: Wetterlage setzen. Geht als Absicht ans Netz — der
   * Server prüft die Rolle, klemmt die Werte und schickt das Ergebnis an ALLE
   * zurück. Lokal wird bewusst nichts vorweggenommen: sonst zeigte die eigene
   * Ansicht ein Wetter, das der Server abgelehnt hat.
   */
  devSetWeather(weather: WeatherState): void {
    this.socket?.sendDevWeather(weather);
  }

  /** Entwickler: Testkiste vor dem Bug — Rolle und Klemmen prüft der Server. */
  devSpawnCrate(coins: number): void {
    this.socket?.sendDevCrate(coins);
  }

  /**
   * Rohr-Befehl ans Netz. Offline gibt es keine Rohre — dort ist das ein
   * No-op, wie bei allen anderen Befehlen ohne Server.
   */
  orderTube(index: number, action: 'laden' | 'scharf', armed?: boolean): void {
    this.socket?.sendTube(index, action, armed);
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

  /**
   * Stufe rauf/runter (W/S, Mausrad). Basis ist die OPTIMISTISCHE Pending-
   * Stufe, nicht der server-bestätigte Stand: die Bestätigung (`own`) hinkt
   * einen Roundtrip hinterher — ohne Pending-Basis rechnete jeder Druck
   * innerhalb der Latenz vom selben alten Stand, und W-Hämmern brachte
   * insgesamt nur EINE Stufe („der Schub geht nicht").
   */
  nudgeTelegraph(delta: number): void {
    const own = this.ownVessel;
    if (!own) return;
    const base = this.pendingTelegraphStep ?? own.telegraphStep;
    this.orderTelegraph(base + delta);
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

    // Auswahl verfällt mit dem Ziel: versenkt oder aus der Ortung gefallen.
    if (this.selectedId && !world.entities.get(this.selectedId)) {
      this.selectedId = null;
      world.entities.setSelectedId(null);
    }

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

    // Klangkulisse: Ambient nach Tauchtiefe, Motor nach Fahrt und Bauart.
    this.audio?.update(
      own
        ? {
            depth: own.depth,
            power: own.maxForward > 0 ? Math.abs(own.speed) / own.maxForward : 0,
            submarine: this.shipStats(own.model).type === SHIP_TYPE_SUBMARINE,
          }
        : null,
    );

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

    // Zielmodus: Peilung zur Maus + Ziellinie (nutzt die Kameramatrix des
    // Vorframes — bei 60 Hz unsichtbar, dafür ohne doppelten Matrixbau).
    this.updateAiming();

    // Reihenfolge ist zwingend: erst simulieren, dann die Ansichten nachziehen,
    // dann die Kamera folgen lassen, dann die Matrizen bauen. Andersherum folgt
    // die Kamera der Position des Vorframes und der nächste Rechtsklick rechnet
    // mit einer veralteten Matrix.
    // Tag/Nacht: nur nachziehen, wenn die Uhr überhaupt läuft — bei einer
    // festen Stimmung wären das sonst Uniform-Uploads für nichts.
    if (this.weather.dayLengthMinutes > 0) {
      this.weatherSeconds += frameSeconds;
      world.setWeather(this.weather, currentHour(this.weather, this.weatherSeconds));
    }

    world.update(frameSeconds);
    world.syncViews(frameSeconds);
    world.updateFollow(frameSeconds);

    /*
     * ENDLOS-KARTE, Rebase: nach einer Kartenrunde liegt die Kamera weit
     * außerhalb von [0, Kante) — dann wandern Kamera, Spiegel, Spuren,
     * Effekte und die Wasser-Offsets GEMEINSAM um genau eine Kartenlänge
     * zurück. Im selben Frame verschoben ist der Bildinhalt identisch; die
     * Hysterese (±¼ Kante) hält den Vorgang selten und das Ozean-Quad klein.
     */
    {
      const karte = world.currentMap;
      const cam = world.camera;
      let shiftX = 0;
      let shiftY = 0;
      if (cam.x < -karte.width * 0.25) shiftX = karte.width;
      else if (cam.x > karte.width * 1.25) shiftX = -karte.width;
      if (cam.y < -karte.height * 0.25) shiftY = karte.height;
      else if (cam.y > karte.height * 1.25) shiftY = -karte.height;
      if (shiftX !== 0 || shiftY !== 0) world.rebase(shiftX, shiftY);
    }
    // Blickversatz NACH der Nachführung und VOR der Matrix: er ist ein
    // Bildschirm-Versatz auf die fertige Kameraposition, keine zweite Kamera.
    this.updatePeek(app.screen.width, app.screen.height);
    world.updatePeek(frameSeconds);
    world.applyCamera(app.screen.width, app.screen.height);

    // Ganz am Ende: die GUI liest denselben Zustand, der gerade gerendert wurde.
    writeHud(frameSeconds);

    /*
     * Fertigmeldung an den Ladebildschirm — bewusst EIN Bild verzögert.
     *
     * Wenn das eigene Boot auftaucht, ist dieser Frame noch gar nicht
     * gezeichnet: Pixi rendert erst NACH dem Ticker-Rückruf. Würde hier sofort
     * gemeldet, verschwände der Ladebildschirm über einem leeren Bild, und der
     * erste Ozean-Frame (Shader-Übersetzung) ruckelte offen sichtbar. Eine
     * Runde später ist genau dieses Bild auf dem Schirm.
     */
    if (!this.readyFired) {
      if (this.readySeen) {
        this.readyFired = true;
        this.readyHook?.();
      } else if (this.ownVessel) {
        this.readySeen = true;
      }
    }
  }

  destroy(): void {
    this.disposed = true;
    this.socket?.disconnect();
    this.socket = null;
    this.snapshots.length = 0;
    this.previousProjectileIds.clear();
    this.audio?.destroy();
    this.audio = null;
    this.readyHook = null;
    this.progressHook = null;
    this.readySeen = false;
    this.readyFired = false;
    this.ownHp = null;
    this.ownArmor = null;
    this.ownLoot = 0;
    this.ownExtractionSeconds = 0;
    this.ownAmmo = {};
    this.ownTubes = [];
    this.pendingTelegraphStep = null;
    setSunkNotice(false);
    if (this.tiltKeys) window.removeEventListener('keydown', this.tiltKeys);
    this.tiltKeys = null;
    if (this.steerListeners) {
      window.removeEventListener('keydown', this.steerListeners.down);
      window.removeEventListener('keyup', this.steerListeners.up);
      window.removeEventListener('blur', this.steerListeners.blur);
      this.steerListeners = null;
    }
    if (this.contextMenuBlocker && this.app) {
      this.app.canvas.removeEventListener('contextmenu', this.contextMenuBlocker);
    }
    this.contextMenuBlocker = null;
    if (this.mouseMoveListener && this.app) {
      this.app.canvas.removeEventListener('pointermove', this.mouseMoveListener);
    }
    this.mouseMoveListener = null;
    if (this.mouseLeaveListener && this.app) {
      this.app.canvas.removeEventListener('pointerleave', this.mouseLeaveListener);
    }
    this.mouseLeaveListener = null;
    if (this.peekButtonListeners) {
      this.app?.canvas.removeEventListener('pointerdown', this.peekButtonListeners.down);
      window.removeEventListener('pointerup', this.peekButtonListeners.up);
      this.peekButtonListeners = null;
    }
    this.peekHeld = false;
    this.aiming = false;
    this.aimBearing = null;
    this.mouseScreen = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
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
    // Diskret wie das Modell: eine Rauchstufe „interpoliert" nicht.
    smoke: b.smoke,
    level: b.level,
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
    // ⚠️ sink MUSS mitlaufen: dieses Objekt ERSETZT den Serverzustand in der
    // Ansicht. Ohne das Feld zeigte die Wasserbombe bis zur Detonation die
    // Flug-Optik — der ganze Sink-Look (Tönung, Schrumpfen, Blasenring) hing
    // an einem Feld, das die Interpolation hier verschluckte.
    sink:
      a.sink !== undefined || b.sink !== undefined
        ? (a.sink ?? 0) + ((b.sink ?? 0) - (a.sink ?? 0)) * t
        : undefined,
  };
}
