import { VIEW } from '../config';
import type { World } from './World';

/**
 * Maussteuerung der Kamera. Heute bleibt davon EINE Sache: das Rad zoomt.
 *
 * Das Ziehen der Karte ist absichtlich weg. Die Kamera hängt fest am eigenen
 * Boot — eine frei verschobene Ansicht gibt es nicht mehr, und damit auch nicht
 * mehr die Frage, wie man aus ihr zurückfindet. Umschauen läuft über den
 * Blickversatz zur Maus (`World.setPeekTarget`, gespeist aus `Game.step`).
 *
 * Auch das Zoomen auf den Cursor ist damit hinfällig: bei fester Nachführung
 * zöge die Kamera den angepeilten Punkt binnen Millisekunden wieder in die
 * Mitte — der Zoom fühlte sich klebrig an. Es bleibt der reine Maßstabswechsel,
 * geklemmt auf VIEW.minZoom..maxZoom.
 */
export class CameraController {
  private readonly canvas: HTMLCanvasElement;
  private readonly world: World;

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.canvas = canvas;
    this.world = world;

    canvas.style.touchAction = 'none';
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  destroy(): void {
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();

    const direction = Math.sign(event.deltaY);
    if (direction === 0) return;

    const factor = direction < 0 ? VIEW.zoomStep : 1 / VIEW.zoomStep;
    this.world.setZoom(this.world.camera.zoom * factor);
  };
}
