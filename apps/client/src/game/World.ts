import type { GameMap, WeatherState } from '@subwarfare/shared';
import { atmosphereFor } from '@subwarfare/shared';
import { Container, Graphics, Matrix, Point } from 'pixi.js';
import { FALLBACK_MAP, FOLLOW, HULL, VIEW, VISION } from '../config';
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

  /**
   * Unterwasser-Schleier — liegt ÜBER allen Weltebenen und unter dem HUD.
   * Alpha folgt der Tauchtiefe des eigenen Boots: je tiefer, desto mehr
   * kippt die ganze Karte in die Unterwasser-Stimmung.
   */
  private readonly underwater = new Graphics();
  private underwaterDepth = 0;
  private underwaterSize = { width: 0, height: 0 };

  /**
   * Sicht-Verdunkelung — liegt IN der Wasserebene (gekippt), damit der
   * Sichtkreis als Welt-Kreis gezeichnet werden kann und die Projektion die
   * richtige Ellipse daraus macht. Über dem Ozean, unter den Schiffen.
   */
  private readonly visionShade = new Graphics();

  /**
   * Kampf-Effekte (Einschläge, Versenkungen): kurzlebige, jeden Frame neu
   * gezeichnete Ringe in der Wasserebene — eine Explosion liegt AUF dem
   * Wasser, die Projektion macht die Ellipse daraus.
   */
  private readonly fx = new Graphics();
  private readonly fxEntries: Array<{ x: number; y: number; age: number; big: boolean }> = [];

  /**
   * Ziellinie des Waffen-Zielmodus (Q): vom eigenen Boot zur Maus, in der
   * Wasserebene wie die frühere Wegpunktlinie. Rot, wenn die Peilung in
   * keinem gültigen Feuersektor liegt.
   */
  private readonly aimLine = new Graphics();

  private map: GameMap = FALLBACK_MAP;
  private ocean: Ocean | null = null;
  private followTarget: Vessel | null = null;

  /** Wiederverwendet — `applyCamera` läuft 60-mal pro Sekunde. */
  private readonly groundMatrix = new Matrix();
  private readonly entityMatrix = new Matrix();
  private readonly scratch = new Point();

  constructor() {
    this.container.addChild(this.groundLayer, this.hullLayer, this.entityLayer, this.underwater);
    this.underwater.visible = false;

    this.ocean = new Ocean(this.map);
    this.groundLayer.addChild(this.ocean.mesh, this.visionShade);
    // Effekte über die Rümpfe: eine Explosion verdeckt das Schiff, nicht
    // umgekehrt. `hullLayer` sortiert nach zIndex — hoch genug wählen.
    this.fx.zIndex = 1_000_000;
    this.hullLayer.addChild(this.fx);
    // Ziellinie knapp darunter — über allen Spuren, unter den Explosionen.
    this.aimLine.zIndex = 999_999;
    this.hullLayer.addChild(this.aimLine);
    // Wegpunktgrafik in die Wasserebene, Richtungs-Billboards in die
    // aufrechte Ebene — siehe EntityLayer.
    this.entities = new EntityLayer(this.hullLayer, this.entityLayer);

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
    this.updateFx(frameSeconds);
  }

  /**
   * Wetterlage übernehmen: Seegang und die daraus abgeleitete Atmosphäre.
   * Läuft bei stehender Uhr einmal, bei laufendem Tag/Nacht-Wechsel je Frame.
   */
  setWeather(weather: WeatherState, hour: number): void {
    this.ocean?.setSeaState(weather.seaState);
    this.ocean?.setAtmosphere(atmosphereFor(weather, hour));
  }

  /**
   * Startet einen Kampf-Effekt: Einschlag (klein) oder Versenkung (groß).
   * Der Zeitpunkt kommt vom Server (fx-Ereignis) — hier wird nur gezeichnet.
   */
  spawnImpact(x: number, y: number, big: boolean): void {
    this.fxEntries.push({ x, y, age: 0, big });
  }

  /** Malt alle laufenden Effekte neu und wirft abgelaufene ab. */
  private updateFx(frameSeconds: number): void {
    const g = this.fx;
    if (this.fxEntries.length === 0) {
      // Nur einmal leeren, nicht jeden Frame neu — clear() invalidiert Geometrie.
      if (g.context.instructions.length > 0) g.clear();
      return;
    }

    g.clear();
    for (let i = this.fxEntries.length - 1; i >= 0; i -= 1) {
      const fx = this.fxEntries[i]!;
      fx.age += frameSeconds;
      const dauer = fx.big ? 1.6 : 0.9;
      if (fx.age >= dauer) {
        this.fxEntries.splice(i, 1);
        continue;
      }

      const t = fx.age / dauer;
      const maxRadius = fx.big ? 120 : 55;
      const radius = 8 + t * maxRadius;
      const fade = 1 - t;

      // Heller Kern, der schnell verglüht, plus auslaufender Druckring.
      if (t < 0.35) {
        const kern = 1 - t / 0.35;
        g.circle(fx.x, fx.y, radius * 0.5).fill({ color: 0xffd27a, alpha: 0.75 * kern });
      }
      g.circle(fx.x, fx.y, radius).stroke({
        color: fx.big ? 0xff9a4a : 0xf2e8c8,
        alpha: 0.8 * fade,
        width: fx.big ? 6 : 3,
      });
      if (fx.big) {
        g.circle(fx.x, fx.y, radius * 0.62).stroke({ color: 0xffd27a, alpha: 0.5 * fade, width: 3 });
      }
    }
  }

  /**
   * Zeichnet die Sicht-Verdunkelung neu: alles außerhalb von Kreis und
   * Periskop-Kegel liegt im Dunkeln. Radius/Kegellänge 0 lässt das jeweilige
   * Loch weg — bei beidem 0 ist die ganze See dunkel („man sieht nichts").
   */
  setVision(x: number, y: number, headingDegrees: number, circleRadius: number, coneLength: number): void {
    const g = this.visionShade;
    g.clear();

    // Großzügig über die Karte hinaus — der Rand außerhalb ist ohnehin dunkel.
    // Pixi-v8-Muster: erst füllen, dann je Loch Form zeichnen und `cut()`.
    const M = 6_000;
    g.rect(-M, -M, this.map.width + 2 * M, this.map.height + 2 * M).fill({
      color: 0x02090f,
      alpha: VISION.darkness,
    });

    if (circleRadius > 1) {
      g.circle(x, y, circleRadius).cut();
    }
    if (coneLength > 1) {
      const half = (VISION.coneHalfAngleDeg * Math.PI) / 180;
      const kurs = ((headingDegrees - 90) * Math.PI) / 180; // 0° = Nord, Welt-y zeigt nach Süden
      const l = coneLength / Math.cos(half);
      g.poly([
        x, y,
        x + Math.cos(kurs - half) * l, y + Math.sin(kurs - half) * l,
        x + Math.cos(kurs + half) * l, y + Math.sin(kurs + half) * l,
      ]).cut();
    }
  }

  /**
   * Zeichnet die Ziellinie neu — oder löscht sie (`null`). Der Stil folgt der
   * früheren Wegpunktlinie; ungültige Peilung wird rot.
   */
  setAimLine(
    line: {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      valid: boolean;
      /** Halber Streuwinkel in Grad (Seegang) — 0 zeichnet nur die Linie. */
      spreadDeg?: number;
    } | null,
  ): void {
    const g = this.aimLine;
    g.clear();
    if (!line) return;

    const color = line.valid ? HULL.markerColor : 0xe2555a;
    g.moveTo(line.x0, line.y0)
      .lineTo(line.x1, line.y1)
      .stroke({ color, alpha: line.valid ? 0.55 : 0.7, pixelLine: true });

    /*
     * Streukegel bei Seegang. Er ist keine Verzierung, sondern Ehrlichkeit:
     * Der Server würfelt die Peilung innerhalb dieses Winkels aus. Ohne die
     * Anzeige gingen Schüsse scheinbar grundlos daneben — mit ihr sieht man,
     * wie die See die Genauigkeit frisst, und kann näher heranfahren.
     */
    const spread = line.spreadDeg ?? 0;
    if (spread > 0.05) {
      const dx = line.x1 - line.x0;
      const dy = line.y1 - line.y0;
      const laenge = Math.hypot(dx, dy);
      if (laenge > 1) {
        const winkel = Math.atan2(dy, dx);
        const halb = (spread * Math.PI) / 180;
        for (const seite of [-1, 1]) {
          const a = winkel + halb * seite;
          g.moveTo(line.x0, line.y0)
            .lineTo(line.x0 + Math.cos(a) * laenge, line.y0 + Math.sin(a) * laenge)
            .stroke({ color, alpha: line.valid ? 0.28 : 0.35, pixelLine: true });
        }
      }
    }

    // Kleine Marke am Zielpunkt — dieselbe Sprache wie der alte Wegpunktring.
    g.circle(line.x1, line.y1, Math.max(18, 10 / this.camera.zoom)).stroke({
      color,
      alpha: 0.8,
      pixelLine: true,
    });
  }

  /** Tauchtiefe des eigenen Boots (0..1) — steuert den Unterwasser-Schleier. */
  setUnderwaterDepth(depth: number): void {
    this.underwaterDepth = Math.min(Math.max(depth, 0), 1);
    this.underwater.visible = this.underwaterDepth > 0.001;
    this.underwater.alpha = this.underwaterDepth;
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

    // Der Schleier ist Bildschirmfläche — nur bei Größenwechsel neu zeichnen.
    if (
      this.underwaterSize.width !== viewportWidth ||
      this.underwaterSize.height !== viewportHeight
    ) {
      this.underwaterSize = { width: viewportWidth, height: viewportHeight };
      this.underwater
        .clear()
        .rect(0, 0, viewportWidth, viewportHeight)
        // Tiefes Grünblau, bewusst nicht schwarz: unter Wasser wird es
        // dunkler UND farbiger, nicht einfach finster.
        .fill({ color: 0x06222e, alpha: 0.55 });
    }
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
