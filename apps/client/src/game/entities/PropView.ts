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

    /*
     * Auf der Dünung SCHWIMMEN, nicht liegen. Wellen bewegen Treibgut auf
     * ORBITALBAHNEN — und von (nahezu) senkrecht oben ist vom Auf und Ab
     * nichts zu sehen (der Höhenversatz skaliert mit √(1 − tilt²), bei
     * tilt 1 exakt null). Sichtbar bleiben drei Signale, alle relativ zur
     * GRÖSSE der Requisite, damit Kiste und Boje gleichermaßen leben:
     * - Drift in der Wasserebene (der Kreis der Orbitalbahn von oben),
     * - „Atmen" der Größe (auf dem Wellenberg näher an der Kamera),
     * - bei gekippter Sicht zusätzlich der echte Hub.
     * Zwei überlagerte Perioden, je Instanz phasenversetzt — sonst wippt die
     * ganze See im Gleichtakt.
     */
    const tilt = getTilt();
    const langsam = this.time * 1.25 + this.phase;
    const schnell = this.time * 2.1 + this.phase * 1.7;
    const hub = Math.sin(langsam) * 0.7 + Math.sin(schnell) * 0.3;
    const drift = Math.cos(langsam) * 0.7 + Math.cos(schnell) * 0.25;

    const breite = frame.texture.width * frame.metresPerPx;
    const hoehe = frame.texture.height * frame.metresPerPx;
    const atmen = 1 + hub * 0.045;
    this.sprite.width = breite * atmen;
    this.sprite.height = hoehe * atmen;
    this.sprite.x = drift * hoehe * 0.07;
    this.sprite.y = hub * hoehe * (0.045 * tilt + 0.09 * Math.sqrt(1 - tilt * tilt));
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
