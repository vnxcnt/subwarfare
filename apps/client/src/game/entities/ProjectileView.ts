import type { ProjectileState } from '@subwarfare/shared';
import { DEG, angleDelta } from '@subwarfare/shared';
import { Container, Graphics, Sprite } from 'pixi.js';
import { getTilt } from '../Projection';
import { directionFrame } from '../textures';

/**
 * Mindestlänge eines Projektils auf dem Bildschirm. Ein 10-m-Torpedo wäre bei
 * Übersichtszoom sonst ein Subpixel — man würde beschossen, ohne je etwas zu
 * sehen. Kleiner als der Schiffs-Wächter (18 px), Projektile dürfen klein wirken.
 */
const MIN_SCREEN_PX = 9;
const MAX_BOOST = 4;

/**
 * Darstellung eines Projektils — dasselbe Richtungs-Billboard-Prinzip wie
 * `VesselView`, aber bewusst ohne dessen Ballast: kein Crossfade-Geist (ein
 * Torpedo läuft geradeaus, sein Frame wechselt praktisch nie), kein Periskop,
 * keine Wegpunktgrafik, keine Tauch-Tönung. Position und Kurs kommen aus dem
 * interpolierten Serverzustand, gerechnet wird hier nichts.
 */
export class ProjectileView {
  private readonly root = new Container();
  private readonly sprite: Sprite | Graphics;

  constructor() {
    this.sprite = createBody();
    this.root.addChild(this.sprite);
  }

  attach(billboardLayer: Container): void {
    billboardLayer.addChild(this.root);
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
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
  }

  destroy(): void {
    this.root.removeFromParent();
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
