import type { ProjectileState } from '@subwarfare/shared';
import { DEG, GUN, angleDelta } from '@subwarfare/shared';
import { Container, Graphics, Sprite } from 'pixi.js';
import { getTilt } from '../Projection';
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
 * Torpedos laufen UNTER der Oberfläche: dieselbe Tiefen-Optik wie getauchte
 * Boote (Tint + Transparenz), auf eine feste Sichttiefe gelegt — tief genug
 * für „unter Wasser", flach genug, dass man dem Ding ausweichen kann.
 */
const RUN_DEPTH = 0.55;

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

  /** Zuletzt angewandte Oberflächen-/Unterwasser-Optik — nur bei Wechsel neu setzen. */
  private surfaceLook: boolean | null = null;

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
    const surface = state.model === GUN.model;
    if (this.surfaceLook !== surface && this.sprite instanceof Sprite) {
      this.surfaceLook = surface;
      this.sprite.tint = surface ? 0xffffff : tintForDepth(RUN_DEPTH);
      this.sprite.alpha = surface ? 1 : 1 - RUN_DEPTH * 0.5;
    }

    if (this.sprite instanceof Sprite) {
      const frame = directionFrame(state.model, state.rotation);
      if (frame) {
        if (this.sprite.texture !== frame.texture) {
          this.sprite.texture = frame.texture;
          this.sprite.anchor.set(frame.anchor.x, frame.anchor.y);
        }
        this.sprite.rotation = angleDelta(frame.angleDegrees, state.rotation) * DEG;
        this.sprite.width = frame.texture.width * frame.metresPerPx;
        this.sprite.height = frame.texture.height * frame.metresPerPx;
      }
    } else {
      this.sprite.rotation = state.rotation * DEG;
    }

    // Mindestgrößen-Wächter gegen das Verschwinden bei Übersichtszoom —
    // mit der ECHTEN Modelllänge: die 4-m-Granate braucht mehr Boost als
    // der 10-m-Torpedo, sonst bricht die Zusicherung genau für sie.
    const lengthMetres = surface ? 4 : 10;
    const screenLength = lengthMetres * getTilt() * zoom;
    const boost = MIN_SCREEN_PX / screenLength;
    this.root.scale.set(Math.min(Math.max(boost, 1), MAX_BOOST));

    // Spur entgegen dem Kurs: Blasen (unter Wasser) bzw. Tracer (Granate).
    const heading = state.rotation * DEG;
    const backX = -Math.sin(heading);
    const backY = Math.cos(heading);
    this.trail.clear();
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
