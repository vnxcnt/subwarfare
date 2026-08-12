import { Container, Sprite } from 'pixi.js';
import { RENDER_ELEVATION, getTilt, screenAxisAngle } from '../Projection';
import { directionFrame } from '../textures';

/**
 * Requisite auf dem Wasser: Lootkiste, Boje — Dinge, die liegen statt fahren.
 *
 * Dasselbe Richtungs-Billboard wie Schiffe und Projektile, aber ohne deren
 * Ballast: kein Crossfade, keine Spur, kein Schatten. Der Kurs ist je Instanz
 * fest gewürfelt (aus der Kennung abgeleitet), damit nicht jede Kiste
 * identisch im Wasser liegt, und ein langsames Pendeln um diesen Kurs lässt
 * die Requisite in der Dünung arbeiten statt festgenagelt zu wirken.
 */
export class PropView {
  private readonly root = new Container();
  private readonly sprite = new Sprite();
  private readonly model: string;
  /** Fester Grundkurs dieser Instanz in Grad. */
  private readonly baseCourse: number;
  /** Phasenversatz des Pendelns — sonst wippt alles im Gleichtakt. */
  private readonly phase: number;
  private time = 0;

  constructor(model: string, seed: string) {
    this.model = model;
    // Billige, stabile Streuung aus der Kennung — Math.random wäre bei jedem
    // Neuaufbau der Ansicht (Sichtkreis rein/raus) ein anderer Kurs.
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    this.baseCourse = ((hash % 360) + 360) % 360;
    this.phase = ((hash >> 9) % 100) / 100 * Math.PI * 2;
    this.root.addChild(this.sprite);
  }

  attach(billboardLayer: Container): void {
    billboardLayer.addChild(this.root);
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  sync(x: number, y: number, frameSeconds: number): void {
    this.time += frameSeconds;
    // Vorprojiziert wie Schiffe und Projektile — die aufrechte Ebene staucht
    // nicht selbst.
    this.root.position.set(x, y * getTilt());
    this.root.zIndex = Math.round(y);

    // ±4° Pendeln in ~7 s: in der Dünung arbeiten, nicht kreiseln.
    const course = this.baseCourse + Math.sin(this.time * 0.9 + this.phase) * 4;
    const frame = directionFrame(this.model, course);
    if (!frame) return;
    if (this.sprite.texture !== frame.texture) {
      this.sprite.texture = frame.texture;
      this.sprite.anchor.set(frame.anchor.x, frame.anchor.y);
    }
    this.sprite.rotation =
      screenAxisAngle(course, getTilt()) - screenAxisAngle(frame.angleDegrees, RENDER_ELEVATION);
    this.sprite.width = frame.texture.width * frame.metresPerPx;
    this.sprite.height = frame.texture.height * frame.metresPerPx;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
