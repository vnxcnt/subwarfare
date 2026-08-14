import { Container, Graphics, Text } from 'pixi.js';
import { wrapCoord } from '@subwarfare/shared';
import { getTilt } from './Projection';

/** Kantenlänge eines Planquadrats in Metern — 25-km-Karte ⇒ A1..E5. */
export const GRID_CELL_METRES = 5_000;

/**
 * Planquadrat-Gitter über der See: Linien alle 5 km, je Zelle eine Kennung
 * aus Spaltenbuchstabe (A.. nach Osten) und Zeilennummer (1.. nach Süden).
 *
 * Gezeichnet wird NUR der sichtbare Ausschnitt, jeden Frame neu — auf der
 * Endlos-Karte laufen die Linien damit über die Naht einfach weiter, und die
 * Kennungen kommen aus der GEWRAPPTEN Weltlage: das Planquadrat hinter der
 * Naht heißt wieder A1, genau wie es beim Hinüberfahren erreicht wird.
 *
 * Zwei Ebenen wie bei den Fahrzeugen: die Linien liegen IN der Wasserebene
 * (machen die Projektion mit), die Beschriftung steht aufrecht und hält über
 * `scale = 1/zoom` ihre Bildschirmgröße.
 */
export class GridOverlay {
  private readonly lines = new Graphics();
  private readonly labelLayer = new Container();
  private readonly labelPool: Text[] = [];

  constructor(waterLayer: Container, labelLayer: Container) {
    // Unter allem, was fährt und schäumt — das Gitter ist Kartenwerk.
    this.lines.zIndex = -1_000_000;
    waterLayer.addChild(this.lines);
    this.labelLayer.zIndex = -1_000_000;
    labelLayer.addChild(this.labelLayer);
  }

  update(
    visible: boolean,
    links: number,
    oben: number,
    rechts: number,
    unten: number,
    mapWidth: number,
    mapHeight: number,
    zoom: number,
  ): void {
    this.lines.visible = visible;
    this.labelLayer.visible = visible;
    if (!visible || mapWidth <= 0) {
      if (!visible) this.lines.clear();
      return;
    }

    const zelle = GRID_CELL_METRES;
    const x0 = Math.floor(links / zelle) * zelle;
    const y0 = Math.floor(oben / zelle) * zelle;
    // Strichstärke in Weltmetern, damit sie auf dem Schirm konstant bleibt.
    const strich = 1.5 / zoom;

    const g = this.lines.clear();
    for (let x = x0; x <= rechts + zelle; x += zelle) {
      g.rect(x - strich / 2, oben - zelle, strich, unten - oben + zelle * 2);
    }
    for (let y = y0; y <= unten + zelle; y += zelle) {
      g.rect(links - zelle, y - strich / 2, rechts - links + zelle * 2, strich);
    }
    g.fill({ color: 0x9fd4c8, alpha: 0.13 });

    // Kennungen in die Zellmitten des sichtbaren Ausschnitts.
    let benutzt = 0;
    for (let x = x0; x < rechts && benutzt < this.kapazitaet(); x += zelle) {
      for (let y = y0; y < unten && benutzt < this.kapazitaet(); y += zelle) {
        const label = this.labelAt(benutzt);
        benutzt += 1;
        const spalte = Math.floor(wrapCoord(x + zelle / 2, mapWidth) / zelle);
        const zeile = Math.floor(wrapCoord(y + zelle / 2, mapHeight) / zelle);
        label.text = `${String.fromCharCode(65 + spalte)}${zeile + 1}`;
        // Aufrechte Ebene: die Position bringt die Stauchung selbst mit.
        label.position.set(x + zelle / 2, (y + zelle / 2) * getTilt());
        label.scale.set(1 / zoom);
        label.visible = true;
      }
    }
    for (let i = benutzt; i < this.labelPool.length; i += 1) {
      this.labelPool[i]!.visible = false;
    }
  }

  /** Obergrenze des Label-Pools — bei minZoom sind ~9 Zellen sichtbar. */
  private kapazitaet(): number {
    return 32;
  }

  private labelAt(index: number): Text {
    let label = this.labelPool[index];
    if (!label) {
      label = new Text({
        text: '',
        style: {
          fontFamily: 'Arial, sans-serif',
          fontSize: 15,
          fontWeight: '600',
          letterSpacing: 2,
          fill: 0x9fd4c8,
        },
        anchor: 0.5,
      });
      label.alpha = 0.35;
      this.labelLayer.addChild(label);
      this.labelPool[index] = label;
    }
    return label;
  }

  destroy(): void {
    this.lines.destroy();
    this.labelLayer.destroy({ children: true });
  }
}
