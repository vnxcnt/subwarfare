import { Point } from 'pixi.js';
import { INPUT, VIEW } from '../config';
import { project, unproject } from './Projection';
import type { World } from './World';

/**
 * Maussteuerung der Kamera: Rad zoomt auf den Cursor, Ziehen verschiebt.
 *
 * Beide Operationen rechnen über die Projektionsmatrix und ihre Umkehrung. Die
 * naive Variante („Kamera um deltaY/zoom verschieben") stimmt nur zufällig
 * solange die Projektion achsentreu ist und driftet, sobald sie geschert wird.
 */
export class CameraController {
  private readonly canvas: HTMLCanvasElement;
  private readonly world: World;

  private readonly onManualPan: (() => void) | undefined;

  private dragPointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private dragTravel = 0;
  private panAnnounced = false;

  private readonly scratchA = new Point();
  private readonly scratchB = new Point();

  constructor(canvas: HTMLCanvasElement, world: World, onManualPan?: () => void) {
    this.canvas = canvas;
    this.world = world;
    this.onManualPan = onManualPan;

    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';

    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
  }

  destroy(): void {
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.style.cursor = '';
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();

    const direction = Math.sign(event.deltaY);
    if (direction === 0) return;

    const factor = direction < 0 ? VIEW.zoomStep : 1 / VIEW.zoomStep;
    this.zoomAt(event.offsetX, event.offsetY, this.world.camera.zoom * factor);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.dragPointerId !== null || event.button !== 0) return;

    this.dragPointerId = event.pointerId;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.dragTravel = 0;
    this.panAnnounced = false;
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = 'grabbing';
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.dragPointerId) return;

    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;

    // Erst ab einer echten Zieh-Distanz gilt das als „der Nutzer will selbst
    // schauen" — ein zittriger Klick soll die Kameranachführung nicht abwerfen.
    this.dragTravel += Math.hypot(dx, dy);
    if (!this.panAnnounced && this.dragTravel > INPUT.followBreakPixels) {
      this.panAnnounced = true;
      this.onManualPan?.();
    }

    this.panBy(dx, dy);
    this.lastX = event.clientX;
    this.lastY = event.clientY;
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    // Eine Maus meldet für ALLE Tasten dieselbe pointerId. Ohne die Button-Prüfung
    // beendet ein Rechtsklick den laufenden Links-Pan und gibt den Capture frei.
    // button -1 muss durch, weil derselbe Handler an `pointercancel` hängt.
    if (event.pointerId !== this.dragPointerId) return;
    if (event.button !== 0 && event.button !== -1) return;

    this.dragPointerId = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    this.canvas.style.cursor = 'grab';
  };

  /** Zoomt so, dass der Weltpunkt unter dem Cursor dort liegen bleibt. */
  private zoomAt(screenX: number, screenY: number, targetZoom: number): void {
    const { camera } = this.world;

    // Bei aktiver Nachführung nur zoomen. Das Verschieben auf den Cursor würde
    // die Nachführung binnen Millisekunden wieder zurückziehen — der Zoom
    // fühlte sich klebrig an.
    if (this.world.isFollowing) {
      this.world.setZoom(targetZoom);
      return;
    }

    // Muss VOR dem Zoomwechsel passieren — danach passt die Matrix nicht mehr.
    const anchor = this.world.screenToWorld(screenX, screenY, this.scratchA);
    const anchorX = anchor.x;
    const anchorY = anchor.y;

    const before = camera.zoom;
    this.world.setZoom(targetZoom);
    const after = camera.zoom;
    if (after === before) return;

    // Aus screen = (P(anker) - P(kamera)) * zoom + mitte folgt für den neuen
    // Kamerapunkt: P(k2) = P(anker) - (P(anker) - P(k1)) * z1/z2.
    // Die Bildmitte kürzt sich dabei heraus, der Viewport wird nicht gebraucht.
    const anchorProjected = project(anchorX, anchorY, this.scratchA);
    const cameraProjected = project(camera.x, camera.y, this.scratchB);
    const ratio = before / after;

    const next = unproject(
      anchorProjected.x - (anchorProjected.x - cameraProjected.x) * ratio,
      anchorProjected.y - (anchorProjected.y - cameraProjected.y) * ratio,
      this.scratchA,
    );
    this.world.centerOn(next.x, next.y);
  }

  private panBy(deltaScreenX: number, deltaScreenY: number): void {
    const { camera } = this.world;
    const projected = project(camera.x, camera.y, this.scratchA);
    const next = unproject(
      projected.x - deltaScreenX / camera.zoom,
      projected.y - deltaScreenY / camera.zoom,
      this.scratchB,
    );
    this.world.centerOn(next.x, next.y);
  }
}
