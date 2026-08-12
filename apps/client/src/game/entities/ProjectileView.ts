import type { ProjectileState } from '@subwarfare/shared';
import { DEG, DEPTH_CHARGE, GUN } from '@subwarfare/shared';
import { Container, Graphics, Sprite } from 'pixi.js';
import { RENDER_ELEVATION, getTilt, screenAxisAngle } from '../Projection';
import { directionFrame } from '../textures';
import { tintForDepth } from './VesselView';

/**
 * Mindestlänge eines Projektils auf dem Bildschirm. Ein 10-m-Torpedo wäre bei
 * Übersichtszoom sonst ein Subpixel — man würde beschossen, ohne je etwas zu
 * sehen. Kleiner als der Schiffs-Wächter (18 px), Projektile dürfen klein wirken.
 */
const MIN_SCREEN_PX = 9;
const MAX_BOOST = 4;

/**
 * Torpedos und Täuschkörper laufen UNTER der Oberfläche: dieselbe Tiefen-Optik
 * wie getauchte Boote (Tint + Transparenz), auf eine feste Sichttiefe gelegt.
 *
 * Deutlich tiefer als anfangs (0,55): bei der alten Einstellung lag die
 * Deckkraft noch bei 0,72 und die Tönung war so mild, dass der Torpedo auf dem
 * Wasser zu schwimmen schien statt darunter zu laufen. Jetzt trägt er dieselbe
 * Handschrift wie ein getauchtes Boot — erkennbar, aber sichtbar UNTER der
 * Oberfläche. Die Blasenspur bleibt der hellste Teil: sie IST die Oberfläche.
 */
const RUN_DEPTH = 0.85;

/** Restdeckkraft eines unter Wasser laufenden Projektils. */
const RUN_ALPHA = 0.5;

/** Blasenspur hinter dem Torpedo: Segmentgrenzen in Metern und ihre Deckkraft. */
const TRAIL_STOPS = [8, 26, 48, 75] as const;
const TRAIL_ALPHA = [0.3, 0.18, 0.08] as const;

/** Tracer hinter der Granate — kürzer und heller als die Blasenspur. */
const SHELL_TRAIL_STOPS = [3, 12, 24, 38] as const;
const SHELL_TRAIL_ALPHA = [0.5, 0.28, 0.12] as const;

/**
 * Darstellung eines Projektils — dasselbe Richtungs-Billboard-Prinzip wie
 * `VesselView`, aber bewusst ohne dessen Ballast: kein Crossfade-Geist (ein
 * Torpedo läuft geradeaus, sein Frame wechselt praktisch nie), kein Periskop,
 * keine Wegpunktgrafik. Dazu die Unterwasser-Tönung und eine Blasenspur in
 * der Wasserebene. Position und Kurs kommen aus dem interpolierten
 * Serverzustand, gerechnet wird hier nichts.
 */
export class ProjectileView {
  private readonly root = new Container();
  private readonly sprite: Sprite | Graphics;
  /** Blasenspur — liegt IN der Wasserebene, die Projektion macht die Schräge. */
  private readonly trail = new Graphics();

  /** Zuletzt angewandte Optik-Signatur — nur bei Wechsel neu setzen. */
  private surfaceLook: string | null = null;

  constructor() {
    this.sprite = createBody();
    this.root.addChild(this.sprite);
  }

  attach(waterLayer: Container, billboardLayer: Container): void {
    waterLayer.addChild(this.trail);
    billboardLayer.addChild(this.root);
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
    this.trail.visible = visible;
  }

  sync(state: ProjectileState, zoom: number): void {
    // Vorprojiziert wie die Schiffe: die aufrechte Ebene staucht nicht selbst.
    this.root.position.set(state.x, state.y * getTilt());
    this.root.zIndex = Math.round(state.y);

    // Granaten fliegen ÜBER dem Wasser: keine Tiefen-Tönung, kein Blasen-,
    // sondern ein heller Tracer. Torpedos/Täuschkörper laufen unter Wasser.
    // Die geworfene Wasserbombe fliegt zunächst über Wasser und taucht dann ein
    // — ihre Optik hängt an der Sinkphase, nicht an einem festen Wert.
    const charge = state.model === DEPTH_CHARGE.model;
    const sink = state.sink ?? 0;
    const surface = state.model === GUN.model || (charge && sink <= 0);
    const look = charge ? `sink:${Math.round(sink * 10)}` : surface ? 'surface' : 'submerged';
    if (this.surfaceLook !== look && this.sprite instanceof Sprite) {
      this.surfaceLook = look;
      if (charge) {
        // Absinken: zügig in die Tiefen-Tönung und fast ganz ausblenden — bei
        // den alten 45 % Restdeckkraft las sich das Fass als „liegt oben".
        // Am Ende bleibt ein dunkler Schemen unter dem Blasenring, dann die
        // Detonation.
        const depth = Math.min(sink * 1.4, 1);
        this.sprite.tint = tintForDepth(depth);
        this.sprite.alpha = 1 - sink * 0.88;
      } else {
        this.sprite.tint = surface ? 0xffffff : tintForDepth(RUN_DEPTH);
        this.sprite.alpha = surface ? 1 : RUN_ALPHA;
      }
    }

    if (this.sprite instanceof Sprite) {
      const frame = directionFrame(state.model, state.rotation);
      if (frame) {
        if (this.sprite.texture !== frame.texture) {
          this.sprite.texture = frame.texture;
          this.sprite.anchor.set(frame.anchor.x, frame.anchor.y);
        }
        // Achs-Ausrichtung statt bloßem Restwinkel: die SICHTBARE Längsachse
        // des Frames (50°-Render) wird exakt auf die PROJIZIERTE Bahn gedreht
        // (tilt ~0,42). Ohne die Korrektur „krabbte" ein diagonal laufendes
        // Projektil bis ~17° schräg neben seiner eigenen Spur her — bei den
        // stabförmigen Projektilen ist die Nachdrehung dagegen unsichtbar.
        // Schiffe bleiben bewusst beim alten Verfahren (komplexe Silhouette).
        this.sprite.rotation =
          screenAxisAngle(state.rotation, getTilt()) -
          screenAxisAngle(frame.angleDegrees, RENDER_ELEVATION);
        this.sprite.width = frame.texture.width * frame.metresPerPx;
        this.sprite.height = frame.texture.height * frame.metresPerPx;
      }
    } else {
      this.sprite.rotation = screenAxisAngle(state.rotation, getTilt());
    }

    // Mindestgrößen-Wächter gegen das Verschwinden bei Übersichtszoom —
    // mit der ECHTEN Modelllänge: die 4-m-Granate braucht mehr Boost als
    // der 10-m-Torpedo, sonst bricht die Zusicherung genau für sie.
    const lengthMetres = state.model === GUN.model ? 4 : charge ? 6 : 10;
    const screenLength = lengthMetres * getTilt() * zoom;
    const boost = MIN_SCREEN_PX / screenLength;
    // Sinkende Bombe schrumpft deutlich — sie entfernt sich nach UNTEN, und
    // in der Draufsicht ist Schrumpfen das einzige Tiefensignal neben Tönung
    // und Deckkraft.
    this.root.scale.set(Math.min(Math.max(boost, 1), MAX_BOOST) * (1 - sink * 0.55));

    this.trail.clear();

    // Die sinkende Wasserbombe zieht keine Spur, sondern hinterlässt einen
    // aufsteigenden Blasenring an der Oberfläche — die Warnung für alles,
    // was darunter fährt.
    if (charge && sink > 0) {
      // Zwei Ringe: ein wachsender äußerer (die aufsteigenden Blasen) und ein
      // kleiner heller an der Einschlagstelle. Kräftiger als die erste
      // Fassung — mit alpha 0,24 und 2 px ging der Ring im Wellenmuster unter,
      // und ohne sichtbaren Ring las sich das Fass als „liegt oben".
      const ring = 6 + sink * DEPTH_CHARGE.blastRadius * 0.45;
      this.trail
        .circle(state.x, state.y, ring)
        .stroke({ color: 0xdff0f7, alpha: 0.55 * (1 - sink * 0.35), width: 3 })
        .circle(state.x, state.y, 4)
        .fill({ color: 0xe8f4fa, alpha: 0.4 * (1 - sink * 0.5) });
      return;
    }

    // Spur entgegen dem Kurs: Blasen (unter Wasser) bzw. Tracer (Granate).
    const heading = state.rotation * DEG;
    const backX = -Math.sin(heading);
    const backY = Math.cos(heading);
    const stops = surface ? SHELL_TRAIL_STOPS : TRAIL_STOPS;
    const alphas = surface ? SHELL_TRAIL_ALPHA : TRAIL_ALPHA;
    const farbe = surface ? 0xffd9a0 : 0xcfe4ee;
    const breite = surface ? 1.4 : 2.5;
    for (let i = 0; i < alphas.length; i += 1) {
      const from = stops[i]!;
      const to = stops[i + 1]!;
      this.trail
        .moveTo(state.x + backX * from, state.y + backY * from)
        .lineTo(state.x + backX * to, state.y + backY * to)
        .stroke({ color: farbe, alpha: alphas[i]!, width: breite });
    }
  }

  destroy(): void {
    this.root.removeFromParent();
    this.trail.removeFromParent();
    this.trail.destroy({ context: true });
    this.root.destroy({ children: true, context: true });
  }
}

/** Torpedo-Sprite; ohne geladene Texturen ein schlichter Strich als Fallback. */
function createBody(): Sprite | Graphics {
  const frame = directionFrame('torpedo01', 0);
  if (frame) return new Sprite({ texture: frame.texture, anchor: frame.anchor });

  return new Graphics()
    .rect(-1, -5, 2, 10)
    .fill({ color: 0xd8e6ee, alpha: 0.9 });
}
