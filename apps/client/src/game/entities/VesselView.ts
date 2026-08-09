import { DEG } from '@subwarfare/shared';
import { Container, Graphics, Sprite } from 'pixi.js';
import { HULL, WATER } from '../../config';
import { getTilt, heightOffsetPerMetre } from '../Projection';
import { getHullTexture, hullSpriteSize } from '../textures';
import type { Vessel } from './Vessel';

const HALF = HULL.length / 2;
const BEAM = HULL.beam / 2;

/** Rumpfumriss von oben, Bug bei -y, Drehpunkt mittschiffs. */
const SILHOUETTE = [
  0, -HALF,
  BEAM * 0.42, -HALF * 0.84,
  BEAM * 0.77, -HALF * 0.62,
  BEAM, -HALF * 0.29,
  BEAM, HALF * 0.47,
  BEAM * 0.83, HALF * 0.69,
  BEAM * 0.5, HALF * 0.87,
  BEAM * 0.27, HALF,
  -BEAM * 0.27, HALF,
  -BEAM * 0.5, HALF * 0.87,
  -BEAM * 0.83, HALF * 0.69,
  -BEAM, HALF * 0.47,
  -BEAM, -HALF * 0.29,
  -BEAM * 0.77, -HALF * 0.62,
  -BEAM * 0.42, -HALF * 0.84,
];

/** Turm-Grundriss, ebenfalls ship-lokal. */
const SAIL = {
  x: -BEAM * 0.28,
  y: -HALF * 0.31,
  width: BEAM * 0.56,
  height: HALF * 0.4,
  radius: BEAM * 0.28,
};

const PING_SECONDS = 0.3;

const SUN = (() => {
  const [x, y, z] = WATER.sun;
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
})();

/**
 * Schattenversatz in Weltunits pro Meter Höhe.
 *
 * Der Schatten liegt IN der Wasserebene — er wird also von der Layer-Matrix
 * ganz von selbst korrekt gestaucht und darf NICHT vorkompensiert werden.
 */
const SHADOW_PER_METRE = { x: -SUN.x / SUN.z, y: -SUN.y / SUN.z };

/**
 * Die sichtbare Seite eines Fahrzeugs. Hängt im **gekippten** `hullLayer`, weil
 * ein Rumpf flach auf dem Wasser liegt und dieselbe Abbildung treffen muss wie
 * die Wasserfläche darunter. Dort ist `rotation = Kurs` vollständig korrekt —
 * das Parent liefert die Projektion, die Kette wird P·R.
 *
 * Aufbau:
 *
 *   root      Weltposition, Tiefensortierung, Gegenskalierung — dreht NICHT
 *    ├─ sailShadow   Weltversatz aus der Sonnenrichtung, Form dreht mit
 *    ├─ hull         dreht mit
 *    └─ sail         Höhenversatz senkrecht nach oben, Form dreht mit
 *
 * Die Versätze sitzen bewusst an den Kindern und nicht im gedrehten Sprite
 * selbst: sonst wanderte der Turm mit dem Kurs im Kreis um den Rumpf.
 */
export class VesselView {
  private readonly root = new Container();
  private readonly hull: Sprite | Graphics;
  private readonly sail: Graphics | null = null;
  private readonly sailShadow: Graphics | null = null;
  private readonly order = new Graphics();

  private lastSerial = -1;
  private pingAge = PING_SECONDS;

  constructor() {
    this.hull = createHull();

    // Nur Aufbauten mit echter Höhe bekommen eine eigene Ebene. Beim Zerstörer
    // stecken sie flach in der Rumpfgrafik, dann entfällt beides.
    if (HULL.sailHeight > 0) {
      this.sail = new Graphics()
        .roundRect(SAIL.x, SAIL.y, SAIL.width, SAIL.height, SAIL.radius)
        .fill({ color: HULL.fill, alpha: 1 })
        .stroke({ color: HULL.stroke, alpha: 0.95, pixelLine: true });

      this.sailShadow = new Graphics()
        .roundRect(SAIL.x, SAIL.y, SAIL.width, SAIL.height, SAIL.radius)
        .fill({ color: 0x000000, alpha: HULL.shadowAlpha });

      // Der Schattenversatz liegt IN der Wasserebene und hängt nur an der Sonne —
      // er ändert sich mit der Neigung nicht und wird deshalb einmalig gesetzt.
      this.sailShadow.position.set(
        SHADOW_PER_METRE.x * HULL.sailHeight,
        SHADOW_PER_METRE.y * HULL.sailHeight,
      );

      this.root.addChild(this.sailShadow, this.hull, this.sail);
    } else {
      this.root.addChild(this.hull);
    }
  }

  attach(layer: Container): void {
    layer.addChild(this.order, this.root);
  }

  sync(model: Vessel, zoom: number, frameSeconds: number): void {
    this.root.position.set(model.x, model.y);
    // Maleralgorithmus: was weiter südlich liegt, liegt weiter vorne.
    this.root.zIndex = Math.round(model.y);

    const course = model.rotation * DEG;
    this.hull.rotation = course;

    if (this.sail && this.sailShadow) {
      this.sail.rotation = course;
      this.sailShadow.rotation = course;
      // Der Höhenversatz hängt an der Neigung und wird deshalb pro Frame gesetzt —
      // sonst bliebe der Turm beim Verstellen von `tilt` in der Luft hängen.
      this.sail.position.set(0, heightOffsetPerMetre() * HULL.sailHeight);
    }

    // Gegenskalierung, damit der Rumpf bei Übersichtszoom nicht verschwindet.
    // Maßgeblich ist der schlimmste Fall — Nord-/Südkurs, wo die Projektion die
    // Länge auf 55 % staucht. UNIFORM und auf `root`, nicht auf die Kinder:
    // nur ein gleichmäßiger Faktor kommutiert mit der Projektion, und nur auf
    // dem gemeinsamen Elternteil bleiben Turm und Schatten am Rumpf.
    const screenLength = HULL.length * getTilt() * zoom;
    const boost = HULL.minScreenPx / screenLength;
    this.root.scale.set(Math.min(Math.max(boost, 1), HULL.maxBoost));

    this.drawOrder(model, zoom, frameSeconds);
  }

  detach(): void {
    this.order.removeFromParent();
    this.root.removeFromParent();
  }

  destroy(): void {
    this.detach();
    // `context: true` ist nötig — die eigenen GraphicsContexts hängen nicht an
    // den Default-DestroyOptions und blieben sonst samt Geometrie auf der GPU.
    this.order.destroy({ context: true });
    this.root.destroy({ children: true, context: true });
  }

  private drawOrder(model: Vessel, zoom: number, frameSeconds: number): void {
    this.order.clear();

    const waypoint = model.waypoint;
    if (!waypoint) return;

    if (model.serial !== this.lastSerial) {
      this.lastSerial = model.serial;
      this.pingAge = 0;
    }
    this.pingAge = Math.min(this.pingAge + frameSeconds, PING_SECONDS);

    // Mindestgröße in Bildschirmpixeln, sonst ist der Marker beim Rausgezoomten
    // ein Punkt.
    const radius = Math.max(HULL.markerRadius, 12 / zoom);
    const ping = 1 - this.pingAge / PING_SECONDS;

    this.order
      .moveTo(model.x, model.y)
      .lineTo(waypoint.x, waypoint.y)
      .stroke({ color: HULL.markerColor, alpha: 0.3, pixelLine: true });

    this.order
      .circle(waypoint.x, waypoint.y, radius)
      .stroke({ color: HULL.markerColor, alpha: 0.75, pixelLine: true });

    if (ping > 0) {
      this.order
        .circle(waypoint.x, waypoint.y, radius * (1 + ping * 1.6))
        .stroke({ color: HULL.markerColor, alpha: 0.5 * ping, pixelLine: true });
    }
  }
}

/**
 * Der Rumpf als Sprite, wenn die Grafik geladen ist — sonst als Vektorpolygon.
 * Der Fallback ist kein Notbehelf: er hält den Client lauffähig, bevor Assets
 * da sind, und bleibt die Referenz für Schiffstypen ohne eigene Grafik.
 */
function createHull(): Sprite | Graphics {
  const texture = getHullTexture();

  if (texture) {
    const size = hullSpriteSize(texture);
    const sprite = new Sprite({ texture, anchor: 0.5 });
    // Die Grafik ist auf ihre Alpha-Grenzen beschnitten und um einen festen
    // Rand erweitert; Breite und Höhe folgen deshalb direkt aus der Auflösung,
    // und der Rand muss nirgends separat verrechnet werden.
    sprite.setSize(size.width, size.height);
    return sprite;
  }

  const graphics = new Graphics()
    .poly(SILHOUETTE, true)
    .fill({ color: HULL.fill, alpha: 0.95 })
    // Die Füllfarbe liegt zwangsläufig nah am Ozeanblau — ohne helle 1-px-Kontur
    // verschwindet der Rumpf im Wasser.
    .stroke({ color: HULL.stroke, alpha: 0.9, pixelLine: true });

  graphics
    .rect(-BEAM * 0.75, -HALF * 0.23, BEAM * 1.5, HALF * 0.04)
    .fill({ color: HULL.stroke, alpha: 0.5 });

  // Kursstrich vor dem Bug — bei kleinem Zoom oft das Einzige, woran man die
  // Fahrtrichtung noch erkennt.
  graphics
    .moveTo(0, -HALF)
    .lineTo(0, -HALF * 1.42)
    .stroke({ color: HULL.stroke, alpha: 0.45, pixelLine: true });

  return graphics;
}
