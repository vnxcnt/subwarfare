import { Application } from 'pixi.js';
import { DEMO_TRAFFIC, DEMO_VESSEL, RENDERER, SIM, VESSEL_DEMO } from '../config';
import { writeHud } from '../state/hud';
import { CameraController } from './CameraController';
import { DemoTraffic } from './DemoTraffic';
import { Vessel } from './entities/Vessel';
import { OrderController } from './OrderController';
import { getTilt, setTilt } from './Projection';
import { loadVesselTextures } from './textures';
import { World } from './World';
import { isTextEntry } from '../ui/dom';

/**
 * Bindeglied zwischen Vue und PixiJS: initialisiert den Renderer, hängt das
 * Canvas in ein DOM-Element und treibt die Welt über den Pixi-Ticker an.
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

  get application(): Application | null {
    return this.app;
  }

  /** Für HUD-Anzeigen (Position, Zoom, Kurs). Null, solange nicht initialisiert. */
  get scene(): World | null {
    return this.world;
  }

  /** Das steuerbare Boot. Vorerst genau eines. */
  get ownVessel(): Vessel | undefined {
    return this.world?.entities.get(DEMO_VESSEL.id);
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

  async init(host: HTMLElement): Promise<void> {
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
    world.applyCamera(app.screen.width, app.screen.height);

    this.camera = new CameraController(app.canvas, world, () => world.stopFollowing());
    this.orders = new OrderController(app.canvas, world, (x, y) => {
      this.ownVessel?.orderMoveTo(x, y);
    });

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

  /**
   * Ein vollständiger Frame. Hängt am Pixi-Ticker, ist aber bewusst eine eigene
   * Methode: so lässt sich das Spiel ohne `requestAnimationFrame` weiterdrehen,
   * etwa zum Prüfen in einer Umgebung, in der der Tab nicht gerendert wird.
   */
  step(frameSeconds: number): void {
    const app = this.app;
    const world = this.world;
    if (!app || !world) return;

    // Feste Schritte: das Fahrmodell ist nichtlinear und mit variablem dt nicht
    // reproduzierbar. Der Deckel begrenzt das Aufholen nach einem Tab-Wechsel.
    this.accumulator += Math.min(frameSeconds, 0.1);
    let steps = 0;
    while (this.accumulator >= SIM.fixedDt && steps < SIM.maxCatchupSteps) {
      world.simulate(SIM.fixedDt);
      this.accumulator -= SIM.fixedDt;
      steps += 1;
    }

    // Reihenfolge ist zwingend: erst simulieren, dann die Ansichten nachziehen,
    // dann die Kamera folgen lassen, dann die Matrizen bauen. Andersherum folgt
    // die Kamera der Position des Vorframes und der nächste Rechtsklick rechnet
    // mit einer veralteten Matrix.
    this.traffic?.update(world.currentMap);
    world.update(frameSeconds);
    world.syncViews(frameSeconds);
    world.updateFollow(frameSeconds);
    world.applyCamera(app.screen.width, app.screen.height);

    // Ganz am Ende: die GUI liest denselben Zustand, der gerade gerendert wurde.
    writeHud(frameSeconds);
  }

  destroy(): void {
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
