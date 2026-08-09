import type { GameMap } from '@subwarfare/shared';
import { Container, Matrix, Point } from 'pixi.js';
import { FALLBACK_MAP, FOLLOW, VIEW } from '../config';
import { EntityLayer } from './entities/EntityLayer';
import type { Vessel } from '@subwarfare/shared';
import { Ocean } from './Ocean';
import { PROJECTION, getTilt, project } from './Projection';

/** Blickpunkt auf die Welt, in Weltkoordinaten. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Render-Seite der Spielwelt.
 *
 * Drei Ebenen, und die Aufteilung ist Absicht:
 * - `groundLayer` bekommt die Projektionsmatrix. Enthält die Wasserfläche.
 * - `hullLayer` bekommt dieselbe Matrix, sortiert aber nach Tiefe. Hier liegt
 *   alles, was flach auf dem Wasser liegt: Rümpfe, Zielmarker, Kurslinien.
 *   Getrennt vom `groundLayer`, weil dort die Ozean-Mesh liegt — mit aktivierter
 *   Sortierung würde sie bei jeder Schiffsbewegung mitsortiert.
 * - `entityLayer` bleibt unverzerrt. Für Text und starre Symbole, die sonst auf
 *   55 % Höhe gestaucht und mit anisotropen Strichstärken dastünden.
 *
 * Weltkoordinaten bleiben durchgängig kartesisch — genau wie der Server sie
 * kennt. Die Neigung ist reine Darstellung.
 */
export class World {
  /** Wurzel, die in die Stage gehängt wird. Bleibt selbst untransformiert. */
  readonly container = new Container();
  readonly groundLayer = new Container();
  readonly hullLayer = new Container({ sortableChildren: true });
  readonly entityLayer = new Container({ sortableChildren: true });

  readonly camera: Camera = { x: 0, y: 0, zoom: 1 };
  readonly entities: EntityLayer;

  private map: GameMap = FALLBACK_MAP;
  private ocean: Ocean | null = null;
  private followTarget: Vessel | null = null;

  /** Wiederverwendet — `applyCamera` läuft 60-mal pro Sekunde. */
  private readonly groundMatrix = new Matrix();
  private readonly entityMatrix = new Matrix();
  private readonly scratch = new Point();

  constructor() {
    this.container.addChild(this.groundLayer, this.hullLayer, this.entityLayer);

    this.ocean = new Ocean(this.map);
    this.groundLayer.addChild(this.ocean.mesh);
    this.entities = new EntityLayer(this.hullLayer);

    this.centerOnMap();
  }

  get currentMap(): GameMap {
    return this.map;
  }

  get isFollowing(): boolean {
    return this.followTarget !== null;
  }

  /**
   * Einziger Eintrittspunkt für Kartendaten. Startet mit `FALLBACK_MAP`, später
   * ruft der Welcome-Handler dieselbe Methode mit `message.map` auf — dadurch
   * wechselt nur der Aufrufer, nie die Signatur.
   */
  setMap(map: GameMap): void {
    this.map = map;
    this.ocean?.resizeTo(map);
    this.centerOnMap();
  }

  /** Begrenzt einen Punkt auf die Karte. Der Server wird später dasselbe tun. */
  clampToMap(x: number, y: number, out: Point = new Point()): Point {
    out.set(clamp(x, 0, this.map.width), clamp(y, 0, this.map.height));
    return out;
  }

  follow(target: Vessel | null): void {
    this.followTarget = target;
  }

  stopFollowing(): void {
    this.followTarget = null;
  }

  centerOn(x: number, y: number): void {
    this.camera.x = clamp(x, 0, this.map.width);
    this.camera.y = clamp(y, 0, this.map.height);
  }

  centerOnMap(): void {
    this.centerOn(this.map.width / 2, this.map.height / 2);
  }

  setZoom(zoom: number): void {
    this.camera.zoom = clamp(zoom, VIEW.minZoom, VIEW.maxZoom);
  }

  /** Zoomstufe, bei der die ganze Karte ins Bild passt. */
  fitZoom(viewportWidth: number, viewportHeight: number): number {
    const size = project(this.map.width, this.map.height, this.scratch);
    const zoom = Math.min(viewportWidth / size.x, viewportHeight / size.y) * VIEW.fitMargin;
    return clamp(zoom, VIEW.minZoom, VIEW.maxZoom);
  }

  fitToMap(viewportWidth: number, viewportHeight: number): void {
    this.setZoom(this.fitZoom(viewportWidth, viewportHeight));
    this.centerOnMap();
  }

  /**
   * Bildschirm -> Welt. Nutzt die zuletzt gesetzte Kameramatrix direkt statt der
   * aus dem Container zurückgerechneten — das bleibt exakt, auch unter Neigung.
   */
  screenToWorld(screenX: number, screenY: number, out: Point = new Point()): Point {
    return this.groundMatrix.applyInverse({ x: screenX, y: screenY }, out);
  }

  /** Welt -> Bildschirm, die Umkehrung von `screenToWorld`. */
  worldToScreen(worldX: number, worldY: number, out: Point = new Point()): Point {
    return this.groundMatrix.apply({ x: worldX, y: worldY }, out);
  }

  /** Fester Simulationsschritt. Läuft mehrfach pro Frame oder auch gar nicht. */
  simulate(dt: number): void {
    this.entities.simulate(dt);
  }

  /** Rein visuelle Animation mit echter Frame-Zeit. */
  update(frameSeconds: number): void {
    this.ocean?.update(frameSeconds, this.camera.zoom);
  }

  syncViews(frameSeconds: number): void {
    this.entities.syncViews(this.camera.zoom, frameSeconds);
  }

  /**
   * Zieht die Kamera exponentiell gedämpft ans Ziel nach.
   * `1 - exp(-lambda*dt)` ist framerate-unabhängig — ein festes `+= delta*0.1`
   * zöge bei 144 Hz mehr als doppelt so schnell wie bei 60 Hz.
   */
  updateFollow(frameSeconds: number): void {
    const target = this.followTarget;
    if (!target) return;

    const alpha = 1 - Math.exp(-FOLLOW.lambda * frameSeconds);
    const dx = target.x - this.camera.x;
    const dy = target.y - this.camera.y;

    // Ohne Snap rechnet die Dämpfung ewig weiter, wenn `centerOn` die Kamera am
    // Kartenrand klemmt und das Ziel dahinter liegt.
    const epsilonX = FOLLOW.snapScreenPx / this.camera.zoom;
    const epsilonY = epsilonX / getTilt();
    if (Math.abs(dx) < epsilonX && Math.abs(dy) < epsilonY) {
      this.centerOn(target.x, target.y);
      return;
    }

    this.centerOn(this.camera.x + dx * alpha, this.camera.y + dy * alpha);
  }

  /** Rechnet Kamera, Zoom und Neigung in die Transformationen der Ebenen. */
  applyCamera(viewportWidth: number, viewportHeight: number): void {
    const { zoom } = this.camera;
    const centre = project(this.camera.x, this.camera.y, this.scratch);
    const tx = viewportWidth / 2 - centre.x * zoom;
    const ty = viewportHeight / 2 - centre.y * zoom;

    this.groundMatrix.copyFrom(PROJECTION).scale(zoom, zoom).translate(tx, ty);
    this.groundLayer.setFromMatrix(this.groundMatrix);
    this.hullLayer.setFromMatrix(this.groundMatrix);

    // Gleiche Kamera, aber ohne Projektion: Symbole und Text bleiben aufrecht.
    this.entityMatrix.identity().scale(zoom, zoom).translate(tx, ty);
    this.entityLayer.setFromMatrix(this.entityMatrix);
  }

  destroy(): void {
    this.entities.destroy();
    this.ocean?.destroy();
    this.ocean = null;
    // `context: true` ist nötig, sonst bleiben die GraphicsContexts der
    // Kinder samt Geometrie auf der GPU liegen.
    this.container.destroy({ children: true, context: true });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
