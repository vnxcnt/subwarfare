import { DEG, DEFAULT_VESSEL_MODEL, angleDelta } from '@subwarfare/shared';
import { Container, Graphics, Sprite } from 'pixi.js';
import { HULL } from '../../config';
import { getTilt } from '../Projection';
import { directionFrame, hasVesselTextures, periscopeFrame } from '../textures';
import type { Vessel } from '@subwarfare/shared';

const HALF = HULL.length / 2;
const BEAM = HULL.beam / 2;

/** Rumpfumriss von oben, Bug bei -y, Drehpunkt mittschiffs. Nur Fallback. */
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

const PING_SECONDS = 0.3;

/**
 * Dauer der Überblendung beim Framewechsel. Kurz genug, um bei 8°/s Drehrate
 * (ein Wechsel alle ~2,8 s) längst fertig zu sein, bevor der nächste kommt —
 * lang genug, dass der Perspektivsprung nicht mehr als Blitz wahrgenommen wird.
 */
const CROSSFADE_SECONDS = 0.13;

/**
 * Die sichtbare Seite eines Fahrzeugs — seit fregatte01 ein
 * **16-Richtungs-Billboard** (bewusste Design-Entscheidung des Users am
 * 2026-08-10), seit dem Smoothing-Umbau mit **stufenloser Drehung**:
 *
 * Pro Kurs wird der nächstliegende Frame (`dir-00..15`) gewählt und das
 * Sprite um den RESTWINKEL zum echten Kurs nachgedreht (±11,25° maximal).
 * Die Fahrtrichtung ändert sich damit kontinuierlich — am Framewechsel
 * springt nur die Perspektive minimal, nie der Kurs. Dass die Optik der
 * gedrehten Frames nicht exakt stimmt, ist die abgesprochene Abwägung.
 *
 * Deshalb lebt das Billboard in der AUFRECHTEN `entityLayer`: dort ist die
 * Restdrehung eine echte Bildschirmdrehung. In der gekippten Wasserebene
 * würde die Projektion das gedrehte Bild scheren (P·R ≠ R·P bei
 * anisotroper Stauchung). Der Preis: die Weltposition muss VORPROJIZIERT
 * werden (`y · tilt`), weil diese Ebene die Stauchung nicht selbst anwendet.
 *
 * Die Wegpunktgrafik bleibt in der Wasserebene — Linien und Ringe liegen
 * flach auf dem Wasser und sollen die Projektion gerade mitmachen.
 */
export class VesselView {
  private readonly root = new Container();
  private readonly hull: Sprite | Graphics;
  private readonly order = new Graphics();

  /**
   * Überblendung beim Framewechsel: der ALTE Frame liegt kurz über dem neuen
   * und blendet aus. Ohne das wechselt die Perspektive als sichtbarer Blitz —
   * mit 130 ms Übergang löst sich das eine Foto ins nächste auf.
   */
  private readonly ghost: Sprite | null = null;
  private ghostAngle = 0;
  private ghostFade = 0;
  /** Maßstab des zuletzt gezeigten Frames — der Geist braucht den ALTEN. */
  private currentMetresPerPx = 1;
  /** Rasterkurs des aktuell gezeigten Frames; null vor dem ersten sync. */
  private currentAngle: number | null = null;

  /** Periskop — sichtbar nur, wenn das Modell eines gesetzt hat (depth+periscope). */
  private readonly periscope: Sprite | null = null;

  private lastSerial = -1;
  private pingAge = PING_SECONDS;

  constructor() {
    this.hull = createHull();
    this.root.addChild(this.hull);

    if (this.hull instanceof Sprite) {
      this.ghost = new Sprite({ texture: this.hull.texture, anchor: 0.5, visible: false });
      // Über dem Rumpf: der alte Frame verdeckt den neuen und gibt ihn beim
      // Ausblenden frei.
      this.root.addChild(this.ghost);

      const frame = periscopeFrame(0);
      if (frame) {
        this.periscope = new Sprite({ texture: frame.texture, anchor: frame.anchor, visible: false });
        this.root.addChild(this.periscope);
      }
    }
  }

  /** Außerhalb der optischen Sicht wird gar nicht erst gezeichnet. */
  setVisible(visible: boolean): void {
    this.root.visible = visible;
    this.order.visible = visible;
  }

  attach(waterLayer: Container, billboardLayer: Container): void {
    waterLayer.addChild(this.order);
    billboardLayer.addChild(this.root);
  }

  sync(model: Vessel, zoom: number, frameSeconds: number, isOwn = false): void {
    // Vorprojiziert: die aufrechte Ebene staucht nicht selbst, also muss die
    // Position die Stauchung mitbringen. `tilt` pro Frame gelesen — er ist
    // zur Laufzeit verstellbar.
    this.root.position.set(model.x, model.y * getTilt());
    // Maleralgorithmus: was weiter südlich liegt, liegt weiter vorne.
    // Sortiert wird nach WELT-y — der Faktor tilt wäre für die Ordnung egal,
    // aber ganzzahliges Welt-y ist stabiler gegen Rundungsflattern.
    this.root.zIndex = Math.round(model.y);

    if (this.hull instanceof Sprite) {
      const frame = directionFrame(model.model, model.rotation);
      if (frame) {
        const metresPerPx = frame.metresPerPx;

        if (this.hull.texture !== frame.texture) {
          // Framewechsel: der bisherige Frame wird zum Geist und blendet aus.
          // Beim allerersten sync (currentAngle noch null) gibt es nichts zu
          // überblenden — das wäre ein Aufblitzen des 0°-Platzhalters.
          if (this.ghost && this.currentAngle !== null) {
            this.ghost.texture = this.hull.texture;
            // Der Geist übernimmt auch den ANKER des alten Frames — jedes
            // Frame hat seinen eigenen Pivot aus den Metadaten. Und den ALTEN
            // Maßstab: bei einem Modellwechsel unterscheiden sich die beiden.
            this.ghost.anchor.copyFrom(this.hull.anchor);
            this.ghostAngle = this.currentAngle;
            this.ghostFade = CROSSFADE_SECONDS;
            this.ghost.visible = true;
            this.ghost.width = this.hull.texture.width * this.currentMetresPerPx;
            this.ghost.height = this.hull.texture.height * this.currentMetresPerPx;
          }
          this.hull.texture = frame.texture;
          this.hull.anchor.set(frame.anchor.x, frame.anchor.y);
        }
        this.currentAngle = frame.angleDegrees;
        this.currentMetresPerPx = metresPerPx;

        // Stufenlos: der Frame zeigt seinen Rasterkurs, der Restwinkel dreht
        // das Bild exakt auf den echten Kurs. Bildschirmdrehung — die Ebene
        // ist uniform skaliert, hier schert nichts.
        this.hull.rotation = angleDelta(frame.angleDegrees, model.rotation) * DEG;

        // Weltmaßstab direkt — keine 1/tilt-Gegenskalierung mehr nötig, die
        // aufrechte Ebene staucht ja nicht.
        this.hull.width = frame.texture.width * metresPerPx;
        this.hull.height = frame.texture.height * metresPerPx;
      }

      if (this.ghost && this.ghost.visible) {
        this.ghostFade -= frameSeconds;
        if (this.ghostFade <= 0) {
          this.ghost.visible = false;
        } else {
          this.ghost.alpha = this.ghostFade / CROSSFADE_SECONDS;
          // Auch der Geist zeigt auf den ECHTEN Kurs — beide Bilder derselben
          // Fahrt, nur aus zwei Perspektiven.
          this.ghost.rotation = angleDelta(this.ghostAngle, model.rotation) * DEG;
        }
      }
    } else {
      // Fallback-Polygon dreht klassisch mit dem Kurs. In der aufrechten
      // Ebene erscheint es ungestaucht — für das Sicherheitsnetz akzeptiert.
      this.hull.rotation = model.rotation * DEG;
    }

    // Tauch-Darstellung: getauchte Boote rutschen optisch unter die
    // Wasseroberfläche — dunkler getönt und durchscheinend. Fremde
    // verschwinden bei voller Tiefe GANZ (sichtbar bleibt höchstens ihr
    // Periskop), das eigene bleibt als Schemen lesbar. Tint/Alpha liegen am
    // RUMPF, nicht am Root — das Periskop ragt über Wasser und bleibt klar.
    const depth = Math.min(Math.max(model.depth, 0), 1);
    const hullAlpha = 1 - depth * (isOwn ? 0.45 : 1);
    this.hull.alpha = hullAlpha;
    if (this.hull instanceof Sprite) this.hull.tint = tintForDepth(depth);
    if (this.ghost) {
      this.ghost.tint = tintForDepth(depth);
      if (this.ghost.visible) this.ghost.alpha = Math.min(this.ghost.alpha, hullAlpha);
    }

    // Periskop: erscheint mit dem Ausfahren, wächst mit dem Ausfahrstand und
    // ist nur relevant, wenn das Boot (teilweise) unter Wasser liegt.
    if (this.periscope) {
      const extend = Math.min(Math.max(model.periscope, 0), 1);
      const relevant = extend > 0.02 && depth > 0.3;
      this.periscope.visible = relevant;
      if (relevant) {
        const frame = periscopeFrame(model.rotation);
        if (frame) {
          if (this.periscope.texture !== frame.texture) {
            this.periscope.texture = frame.texture;
            this.periscope.anchor.set(frame.anchor.x, frame.anchor.y);
          }
          this.periscope.width = frame.texture.width * frame.metresPerPx;
          // Höhe wächst mit dem Ausfahren — das „Aufsteigen" aus dem Wasser.
          this.periscope.height = frame.texture.height * frame.metresPerPx * extend;
          this.periscope.rotation = angleDelta(frame.angleDegrees, model.rotation) * DEG;
        }
      }
    }

    // Gegenskalierung, damit der Rumpf bei Übersichtszoom nicht verschwindet.
    // Bezugsgröße bleibt die projizierte Schiffslänge — für die Billboards eine
    // Näherung, aber als Mindestgrößen-Wächter genau richtig.
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
 * Der Rumpf als Richtungs-Sprite, wenn die Grafiken geladen sind — sonst als
 * Vektorpolygon. Der Fallback ist kein Notbehelf: er hält den Client
 * lauffähig, bevor Assets da sind, und bleibt die Referenz für Schiffstypen
 * ohne eigene Grafik.
 */
/**
 * Tönung nach Tiefe: von Weiß (keine Änderung) zu tiefem Grünblau. Multiplikativ
 * auf dem Container — färbt Rumpf UND Crossfade-Geist gleichermaßen.
 */
function tintForDepth(depth: number): number {
  const r = Math.round(255 - depth * (255 - 0x4e));
  const g = Math.round(255 - depth * (255 - 0x7a));
  const b = Math.round(255 - depth * (255 - 0x8e));
  return (r << 16) | (g << 8) | b;
}

function createHull(): Sprite | Graphics {
  if (hasVesselTextures()) {
    const frame = directionFrame(DEFAULT_VESSEL_MODEL, 0);
    if (frame) {
      // Anker = Modell-Pivot des Frames (aus den Meshy-Metadaten): alle
      // Frames sitzen damit exakt auf demselben Weltpunkt, und die
      // Restwinkel-Drehung dreht um den Rumpf statt um die Bildmitte.
      return new Sprite({ texture: frame.texture, anchor: frame.anchor });
    }
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
