import { Application } from 'pixi.js';
import { RENDERER } from '../config';
import { World } from './World';

/**
 * Bindeglied zwischen Vue und PixiJS: initialisiert den Renderer, hängt das
 * Canvas in ein DOM-Element und treibt die Welt über den Pixi-Ticker an.
 */
export class Game {
  private app: Application | null = null;
  private world: World | null = null;

  get application(): Application | null {
    return this.app;
  }

  async init(host: HTMLElement): Promise<void> {
    if (this.app) return;

    const app = new Application();
    await app.init({
      resizeTo: host,
      background: RENDERER.backgroundColor,
      antialias: RENDERER.antialias,
      preference: RENDERER.preference,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });

    host.appendChild(app.canvas);
    // `resizeTo` misst erst beim nächsten Resize-Event — einmal explizit anstoßen,
    // damit der Renderer nicht auf der Default-Größe 800×600 hängen bleibt.
    app.resize();
    this.app = app;

    const world = new World();
    app.stage.addChild(world.container);
    this.world = world;

    app.ticker.add((ticker) => {
      world.update(ticker.deltaMS / 1000);
      world.applyCamera(app.screen.width, app.screen.height);
    });
  }

  destroy(): void {
    this.world = null;
    this.app?.destroy(true, { children: true });
    this.app = null;
  }
}
