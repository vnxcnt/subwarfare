import { Point } from 'pixi.js';
import { INPUT } from '../config';
import type { World } from './World';

export type OrderHandler = (worldX: number, worldY: number) => void;

/**
 * Fahrbefehle per Rechtsklick. Zwilling des `CameraController` — bewusst eine
 * eigene Klasse mit eigenen Zustandsvariablen, weil eine Maus für ALLE Tasten
 * dieselbe `pointerId` meldet und geteilte Felder sich gegenseitig zerschießen.
 */
export class OrderController {
  private readonly canvas: HTMLCanvasElement;
  private readonly world: World;
  private readonly onOrder: OrderHandler;

  private downX = 0;
  private downY = 0;
  private armed = false;

  private readonly scratch = new Point();

  constructor(canvas: HTMLCanvasElement, world: World, onOrder: OrderHandler) {
    this.canvas = canvas;
    this.world = world;
    this.onOrder = onOrder;

    // Ausschließlich auf dem Canvas. Auf `document` würde das den Rechtsklick
    // im gesamten HUD, in Textfeldern und im DevTools-Inspect mit abwürgen.
    canvas.addEventListener('contextmenu', this.onContextMenu);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
  }

  destroy(): void {
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
  }

  private readonly onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== INPUT.orderButton) return;
    this.armed = true;
    this.downX = event.clientX;
    this.downY = event.clientY;
    // Ohne Capture bliebe `armed` stehen, wenn man auf dem Canvas drückt und
    // über einem HUD-Panel loslässt — der nächste Rechtsklick auf dem Canvas
    // löste dann einen Fahrbefehl aus, den niemand gegeben hat.
    this.canvas.setPointerCapture(event.pointerId);
  };

  private readonly onPointerCancel = (): void => {
    this.armed = false;
  };

  /**
   * Der Befehl kommt aus `pointerup`, nicht aus `contextmenu`: Letzteres feuert
   * plattformabhängig auf Down (macOS, Linux) oder Up (Windows) und lässt sich
   * per Menü-Taste ganz ohne Zeigerposition auslösen.
   */
  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button !== INPUT.orderButton || !this.armed) return;
    this.armed = false;

    const travelled = Math.hypot(event.clientX - this.downX, event.clientY - this.downY);
    if (travelled > INPUT.clickMaxPixels) return;

    const rect = this.canvas.getBoundingClientRect();
    // `world.screenToWorld` und NICHT `unproject` — letzteres kehrt nur die
    // Projektion um, ohne Kamera und Zoom, und liefert plausibel aussehende,
    // falsche Koordinaten.
    const world = this.world.screenToWorld(
      event.clientX - rect.left,
      event.clientY - rect.top,
      this.scratch,
    );

    // Klemmen statt verwerfen, und den Marker an der geklemmten Stelle zeigen —
    // so sieht der Spieler die Korrektur. Der Server wird später dieselbe Regel
    // anwenden; verwerfen auf der einen und klemmen auf der anderen Seite gäbe
    // zwei Vorstellungen davon, was ein gültiger Befehl ist.
    const clamped = this.world.clampToMap(world.x, world.y, this.scratch);
    this.onOrder(clamped.x, clamped.y);
  };
}
