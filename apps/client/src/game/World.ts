import type { GameMap, WeatherState } from '@subwarfare/shared';
import { atmosphereFor } from '@subwarfare/shared';
import { Container, Graphics, Matrix, Point, Sprite } from 'pixi.js';
import { FALLBACK_MAP, FOLLOW, HULL, PEEK, VIEW, VISION } from '../config';
import { gridEnabled } from '../state/settings';
import { EntityLayer } from './entities/EntityLayer';
import type { Vessel } from '@subwarfare/shared';
import { explosionFrame, splashFrame } from './fx-textures';
import { GridOverlay } from './GridOverlay';
import { Ocean } from './Ocean';
import { PROJECTION, getTilt, project } from './Projection';

/** Weltgröße der Kampf-Effekte in Metern — Sichtbarkeit vor Maßstabstreue. */
const FX_SIZE = {
  /** Einschlag einer Granate oder eines Torpedos. */
  splash: 95,
  /** Wassersäule beim Untergang. */
  bigSplash: 190,
  /** Feuerball beim Untergang, bei vollem Aufquellen. */
  fire: 240,
} as const;

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
   * Kampf-Effekte (Einschläge, Versenkungen) als Bildfolgen.
   *
   * Bewusst ZWEI Ebenen, weil die beiden Anteile verschieden im Raum liegen:
   * die Wasserfontäne breitet sich FLACH auf der Oberfläche aus und gehört in
   * die gekippte Wasserebene, der Feuerball steigt SENKRECHT auf und gehört in
   * die aufrechte Ebene — dort würde ihn die Projektion sonst platt scheren.
   */
  private readonly fxWater = new Container();
  private readonly fxUpright = new Container();
  private readonly fxEntries: Array<{
    x: number;
    y: number;
    age: number;
    duration: number;
    splash: Sprite;
    fire: Sprite | null;
  }> = [];

  /**
   * Ziellinie des Waffen-Zielmodus (Q): vom eigenen Boot zur Maus, in der
   * Wasserebene wie die frühere Wegpunktlinie. Rot, wenn die Peilung in
   * keinem gültigen Feuersektor liegt.
   */
  private readonly aimLine = new Graphics();

  private map: GameMap = FALLBACK_MAP;
  private ocean: Ocean | null = null;
  private readonly grid: GridOverlay;
  private followTarget: Vessel | null = null;
  /**
   * Blickversatz zur Maus, in BILDSCHIRMPIXELN. `peek` ist der gezeigte Wert,
   * `peekTarget` der gewünschte — dazwischen liegt die Dämpfung. Bewusst in
   * Bildschirm- statt Weltkoordinaten: der Versatz soll beim Zoomen gleich
   * groß bleiben, und alle Umrechnungen laufen ohnehin über die Matrix, in die
   * er einfließt.
   */
  private readonly peek = { x: 0, y: 0 };
  private readonly peekTarget = { x: 0, y: 0 };

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
    // umgekehrt. Beide Ebenen sortieren nach zIndex — hoch genug wählen.
    this.fxWater.zIndex = 1_000_000;
    this.hullLayer.addChild(this.fxWater);
    // Ziellinie knapp darunter — über allen Spuren, unter den Explosionen.
    this.aimLine.zIndex = 999_999;
    this.hullLayer.addChild(this.aimLine);
    // Wegpunktgrafik in die Wasserebene, Richtungs-Billboards in die
    // aufrechte Ebene — siehe EntityLayer.
    this.entities = new EntityLayer(this.hullLayer, this.entityLayer);
    // Planquadrat-Gitter: Linien in der Wasserebene, Kennungen aufrecht.
    this.grid = new GridOverlay(this.hullLayer, this.entityLayer);
    // Feuerbälle über alle Billboards.
    this.fxUpright.zIndex = 1_000_000;
    this.entityLayer.addChild(this.fxUpright);

    this.centerOnMap();
  }

  get currentMap(): GameMap {
    return this.map;
  }


  /**
   * Einziger Eintrittspunkt für Kartendaten. Startet mit `FALLBACK_MAP`, später
   * ruft der Welcome-Handler dieselbe Methode mit `message.map` auf — dadurch
   * wechselt nur der Aufrufer, nie die Signatur.
   */
  setMap(map: GameMap): void {
    this.map = map;
    this.ocean?.resizeTo(map);
    // Landmassen: der Ozean baut daraus sein Küsten-Abstandsfeld. Karten ohne
    // Inseln schalten den Küstenblock im Shader ab — offenes Wasser sieht
    // danach unverändert aus.
    this.ocean?.setIslands(map);
    // Die Bojen der Extraktionszonen brauchen die Kartengröße für die
    // Torus-Darstellung (nächste Kopie relativ zur Sicht).
    this.entities.setMapSize(map.width, map.height);
    this.centerOnMap();
  }

  /**
   * ENDLOS-KARTE: verschiebt ALLE Render-Weltkoordinaten um eine Kartenlänge —
   * Kamera, Fahrzeug-Spiegel samt Spuren, laufende Effekte und die
   * Wasser-Offsets, gemeinsam im selben Frame. Der Bildinhalt ist danach
   * IDENTISCH; ausgelöst wird das vom Game-Ticker, wenn die Kamera nach einer
   * Kartenrunde zu weit von [0, Kante) weggelaufen ist.
   */
  rebase(dx: number, dy: number): void {
    this.camera.x += dx;
    this.camera.y += dy;
    for (const fx of this.fxEntries) {
      fx.x += dx;
      fx.y += dy;
      fx.splash.position.set(fx.splash.position.x + dx, fx.splash.position.y + dy);
      // Aufrechte Ebene: y trägt die Stauchung selbst (siehe spawnImpact).
      fx.fire?.position.set(fx.fire.position.x + dx, fx.fire.position.y + dy * getTilt());
    }
    this.entities.rebase(dx, dy);
    this.ocean?.applyRebase(dx, dy);
  }

  /** Begrenzt einen Punkt auf die Karte. Der Server wird später dasselbe tun. */
  clampToMap(x: number, y: number, out: Point = new Point()): Point {
    out.set(clamp(x, 0, this.map.width), clamp(y, 0, this.map.height));
    return out;
  }

  follow(target: Vessel | null): void {
    this.followTarget = target;
  }

  /**
   * Blickversatz setzen — Zielwert in Bildschirmpixeln, positiv = nach rechts
   * bzw. nach unten schauen. Der tatsächliche Versatz zieht in `updatePeek`
   * gedämpft nach; hier wird nur das Ziel gesetzt.
   */
  setPeekTarget(x: number, y: number): void {
    this.peekTarget.x = x;
    this.peekTarget.y = y;
  }

  centerOn(x: number, y: number): void {
    // Endlos-Karte: die Kamera darf über die Naht hinauslaufen — zurückgeholt
    // wird sie vom Rebase im Game-Ticker, nicht von einer Klemme.
    this.camera.x = x;
    this.camera.y = y;
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
    const erstes = splashFrame(0);
    if (!erstes) return;

    const splash = new Sprite({ texture: erstes, anchor: 0.5 });
    splash.position.set(x, y);
    splash.width = big ? FX_SIZE.bigSplash : FX_SIZE.splash;
    splash.height = splash.width;
    this.fxWater.addChild(splash);

    let fire: Sprite | null = null;
    const feuerbild = big ? explosionFrame(0) : null;
    if (feuerbild) {
      fire = new Sprite({ texture: feuerbild, anchor: 0.5 });
      // Aufrechte Ebene: die Weltposition muss die Stauchung mitbringen,
      // weil diese Ebene sie nicht selbst anwendet (wie bei den Billboards).
      fire.position.set(x, y * getTilt());
      fire.width = FX_SIZE.fire;
      fire.height = FX_SIZE.fire;
      // ⚠️ NICHT additiv: die Bildfolge geht nach dem Feuer in grauen Rauch
      // über, und additiv aufgetragener Rauch ist auf dunklem Wasser
      // unsichtbar. Die hellen Anfangsbilder tragen sich auch normal.
      this.fxUpright.addChild(fire);
    }

    this.fxEntries.push({
      x,
      y,
      age: 0,
      duration: big ? 1.8 : 1.0,
      splash,
      fire,
    });
  }

  /** Schaltet die Bildfolgen weiter und räumt abgelaufene Effekte ab. */
  private updateFx(frameSeconds: number): void {
    for (let i = this.fxEntries.length - 1; i >= 0; i -= 1) {
      const fx = this.fxEntries[i]!;
      fx.age += frameSeconds;
      const t = fx.age / fx.duration;
      if (t >= 1) {
        fx.splash.destroy();
        fx.fire?.destroy();
        this.fxEntries.splice(i, 1);
        continue;
      }

      const splashBild = splashFrame(t);
      if (splashBild) fx.splash.texture = splashBild;
      // Die Deckkraft der Bildfolge trägt das Ausklingen schon; der Faktor hier
      // fängt nur das letzte Fünftel ab, damit nichts hart verschwindet.
      fx.splash.alpha = Math.min(1, (1 - t) * 5);

      if (fx.fire) {
        // Feuer im ersten Drittel, Rauch danach — beides steckt in derselben
        // Bildfolge, sie läuft über die volle Dauer des Effekts.
        const bild = explosionFrame(t);
        if (bild) fx.fire.texture = bild;
        fx.fire.alpha = Math.min(1, (1 - t) * 4);
        // Der Feuerball quillt auf, statt in fester Größe zu stehen.
        const groesse = FX_SIZE.fire * (0.5 + t * 0.85);
        fx.fire.width = groesse;
        fx.fire.height = groesse;
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

  /**
   * Zieht den Blickversatz an sein Ziel nach — dieselbe framerate-unabhängige
   * Dämpfung wie die Kameranachführung. Ohne sie spränge das Bild mit jeder
   * Mausbewegung mit, statt ihr nachzugeben.
   */
  updatePeek(frameSeconds: number): void {
    const alpha = 1 - Math.exp(-PEEK.lambda * frameSeconds);
    this.peek.x += (this.peekTarget.x - this.peek.x) * alpha;
    this.peek.y += (this.peekTarget.y - this.peek.y) * alpha;
  }

  /** Rechnet Kamera, Zoom und Neigung in die Transformationen der Ebenen. */
  applyCamera(viewportWidth: number, viewportHeight: number): void {
    const { zoom } = this.camera;
    const centre = project(this.camera.x, this.camera.y, this.scratch);
    // Der Blickversatz geht HIER ein und nirgends sonst: damit tragen ihn alle
    // Ebenen, und `screenToWorld` (dieselbe Matrix) rechnet ihn automatisch
    // wieder heraus — Zielen und Zoomen bleiben dadurch punktgenau.
    const tx = viewportWidth / 2 - centre.x * zoom - this.peek.x;
    // `shipLift` hebt den Ruhepunkt über die Fenstermitte: die Anzeige ist
    // unten schwerer, und ohne den Ausgleich rutscht das eigene Boot beim
    // vollen Blick nach vorn hinter die Waffenleiste.
    const ty = viewportHeight / 2 - centre.y * zoom - this.peek.y - VIEW.shipLift;

    this.groundMatrix.copyFrom(PROJECTION).scale(zoom, zoom).translate(tx, ty);
    this.groundLayer.setFromMatrix(this.groundMatrix);
    this.hullLayer.setFromMatrix(this.groundMatrix);

    // Gleiche Kamera, aber ohne Projektion: Symbole und Text bleiben aufrecht.
    this.entityMatrix.identity().scale(zoom, zoom).translate(tx, ty);
    this.entityLayer.setFromMatrix(this.entityMatrix);

    // Sichtbarer Weltausschnitt fürs Planquadrat-Gitter: die Matrix ist
    // achsparallel (Projektion = y-Stauchung, keine Drehung), zwei Ecken
    // genügen. `scratch` ist ab hier frei — `centre` wird nicht mehr gelesen.
    const ecke = this.groundMatrix.applyInverse(this.scratch.set(0, 0), this.scratch);
    const links = ecke.x;
    const oben = ecke.y;
    this.groundMatrix.applyInverse(this.scratch.set(viewportWidth, viewportHeight), this.scratch);
    this.grid.update(
      gridEnabled.value,
      links,
      oben,
      this.scratch.x,
      this.scratch.y,
      this.map.width,
      this.map.height,
      zoom,
    );

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
    this.grid.destroy();
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
