import type { ProjectileState } from '@subwarfare/shared';
import { DEG, angleDelta } from '@subwarfare/shared';
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

  constructor() {
    this.sprite = createBody();
    this.root.addChild(this.sprite);
    if (this.sprite instanceof Sprite) {
      this.sprite.tint = tintForDepth(RUN_DEPTH);
      this.sprite.alpha = 1 - RUN_DEPTH * 0.5;
    }
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

    // Mindestgrößen-Wächter gegen das Verschwinden bei Übersichtszoom.
    const screenLength = 10 * getTilt() * zoom;
    const boost = MIN_SCREEN_PX / screenLength;
    this.root.scale.set(Math.min(Math.max(boost, 1), MAX_BOOST));

    // Blasenspur: kurze, nach hinten auslaufende Segmente entgegen dem Kurs.
    const heading = state.rotation * DEG;
    const backX = -Math.sin(heading);
    const backY = Math.cos(heading);
    this.trail.clear();
    for (let i = 0; i < TRAIL_ALPHA.length; i += 1) {
      const from = TRAIL_STOPS[i]!;
      const to = TRAIL_STOPS[i + 1]!;
      this.trail
        .moveTo(state.x + backX * from, state.y + backY * from)
        .lineTo(state.x + backX * to, state.y + backY * to)
        .stroke({ color: 0xcfe4ee, alpha: TRAIL_ALPHA[i]!, width: 2.5 });
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
