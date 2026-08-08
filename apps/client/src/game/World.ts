import { Container } from 'pixi.js';

/** Blickpunkt auf die Welt, in Weltkoordinaten. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Render-Seite der Spielwelt: ein Wurzel-Container in Weltkoordinaten plus
 * Kamera. Hält noch keine Entities — die kommen aus den State-Updates des
 * Servers, sobald das Protokoll steht.
 */
export class World {
  /** Alles, was in Weltkoordinaten liegt, hängt hier drunter. */
  readonly container = new Container();

  readonly camera: Camera = { x: 0, y: 0, zoom: 1 };

  /** Zentriert die Ansicht auf einen Weltpunkt. */
  centerOn(x: number, y: number): void {
    this.camera.x = x;
    this.camera.y = y;
  }

  /** Rechnet Kamera und Zoom auf die Transformation des Containers um. */
  applyCamera(viewportWidth: number, viewportHeight: number): void {
    this.container.scale.set(this.camera.zoom);
    this.container.position.set(
      viewportWidth / 2 - this.camera.x * this.camera.zoom,
      viewportHeight / 2 - this.camera.y * this.camera.zoom,
    );
  }

  /**
   * Ein Renderschritt.
   * @param _deltaSeconds vergangene Zeit seit dem letzten Frame in Sekunden.
   */
  update(_deltaSeconds: number): void {
    // Interpolation der Server-Zustände folgt später.
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
