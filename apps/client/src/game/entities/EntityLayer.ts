import type { Container } from 'pixi.js';
import { Graphics } from 'pixi.js';
import type { CrateState, ProjectileState, Vessel } from '@subwarfare/shared';
import {
  DEFAULT_VESSEL_MODEL,
  EXTRACTION_BUOYS,
  HULL_DIMENSIONS,
  LOOT_CRATE_MODEL,
  angleDelta,
  norm360,
  torusDelta,
} from '@subwarfare/shared';
import { HULL, VISION } from '../../config';
import { ProjectileView } from './ProjectileView';
import { PropView } from './PropView';
import { VesselView } from './VesselView';

/** Sichtlage des eigenen Boots — von Game je Frame gesetzt. */
export interface VisionState {
  x: number;
  y: number;
  headingDegrees: number;
  circleRadius: number;
  coneLength: number;
}

interface Entry {
  model: Vessel;
  view: VesselView;
}

/**
 * Registry aller Fahrzeuge samt ihrer Darstellung. Besitzt die Container, die
 * sie von außen bekommt — dasselbe Muster wie `Ocean`, damit `World` weder
 * `Vessel` noch `VesselView` kennen muss.
 *
 * Zwei Ebenen, weil ein Fahrzeug in zwei Welten lebt: die Wegpunktgrafik
 * liegt IN der (gekippten) Wasserebene, das Richtungs-Billboard steht
 * AUFRECHT davor — seine Restwinkel-Drehung muss eine echte
 * Bildschirmdrehung sein, in der gekippten Ebene würde sie scheren.
 */
export class EntityLayer {
  private readonly waterLayer: Container;
  private readonly billboardLayer: Container;
  private readonly entries = new Map<string, Entry>();
  /** Projektile: interpolierter Serverzustand + Ansicht, per id. */
  private readonly projectiles = new Map<string, { state: ProjectileState; view: ProjectileView }>();
  /** Lootkisten aus dem Broadcast, per id. */
  private readonly crates = new Map<string, { state: CrateState; view: PropView }>();
  /** Bojen der Extraktionszonen — statisch, einmal beim Kartenempfang gesetzt. */
  private buoys: Array<{ x: number; y: number; view: PropView }> = [];
  private ownId: string | null = null;
  private vision: VisionState | null = null;
  /** Kartenmaße für die Torus-Darstellung der Statiken (Bojen). */
  private mapSize = { width: 0, height: 0 };
  /** Angeklicktes fremdes Schiff — bekommt den Auswahlring. */
  private selectedId: string | null = null;
  private readonly auswahl = new Graphics();

  constructor(waterLayer: Container, billboardLayer: Container) {
    this.waterLayer = waterLayer;
    this.billboardLayer = billboardLayer;
    // In der Wasserebene, unter Ziellinie (999_999) und Wasser-Effekten.
    this.auswahl.zIndex = 999_000;
    waterLayer.addChild(this.auswahl);
  }

  setSelectedId(id: string | null): void {
    this.selectedId = id;
  }

  /** Liegt das Fahrzeug optisch in Sicht (Kreis oder Periskop-Kegel)? */
  sichtbar(id: string): boolean {
    const model = this.get(id);
    return !!model && this.inVision(model.x, model.y);
  }

  setMapSize(width: number, height: number): void {
    this.mapSize = { width, height };
  }

  /**
   * ENDLOS-KARTE: alle Render-Spiegel um eine Kartenlänge verschieben — Teil
   * des gemeinsamen Rebase (siehe World.rebase). Projektile und Kisten
   * brauchen nichts: ihre Positionen kommen jeden Frame frisch und bereits
   * kameranah gewrappt aus dem Game.
   */
  rebase(dx: number, dy: number): void {
    for (const entry of this.entries.values()) {
      entry.model.x += dx;
      entry.model.y += dy;
      entry.view.rebase(dx, dy);
    }
  }

  get count(): number {
    return this.entries.size;
  }

  spawn(model: Vessel): Vessel {
    this.remove(model.id);

    const view = new VesselView();
    view.attach(this.waterLayer, this.billboardLayer);
    this.entries.set(model.id, { model, view });
    return model;
  }

  get(id: string): Vessel | undefined {
    return this.entries.get(id)?.model;
  }

  /**
   * Alle Fahrzeuge. Bewusst ein Iterator und keine Array-Kopie — das Sonar
   * liest das mehrfach pro Sekunde und soll dabei nichts allozieren.
   */
  *models(): IterableIterator<Vessel> {
    for (const entry of this.entries.values()) yield entry.model;
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.view.destroy();
    this.entries.delete(id);
  }

  /**
   * Übernimmt den interpolierten Projektilbestand eines Frames. Neue ids
   * spawnen, fehlende verschwinden sofort — ein Torpedo, der aus dem State
   * fällt, ist eingeschlagen oder abgelaufen, da gibt es nichts zu glätten.
   */
  applyProjectiles(states: ProjectileState[]): void {
    const seen = new Set<string>();
    for (const state of states) {
      seen.add(state.id);
      const existing = this.projectiles.get(state.id);
      if (existing) {
        existing.state = state;
      } else {
        const view = new ProjectileView();
        view.attach(this.waterLayer, this.billboardLayer);
        this.projectiles.set(state.id, { state, view });
      }
    }
    for (const [id, entry] of this.projectiles) {
      if (!seen.has(id)) {
        entry.view.destroy();
        this.projectiles.delete(id);
      }
    }
  }

  /** Lootkisten des Frames — dasselbe Muster wie die Projektile. */
  applyCrates(states: CrateState[]): void {
    const seen = new Set<string>();
    for (const state of states) {
      seen.add(state.id);
      const existing = this.crates.get(state.id);
      if (existing) {
        existing.state = state;
      } else {
        const view = new PropView(LOOT_CRATE_MODEL, state.id);
        view.attach(this.billboardLayer);
        this.crates.set(state.id, { state, view });
      }
    }
    for (const [id, entry] of this.crates) {
      if (!seen.has(id)) {
        entry.view.destroy();
        this.crates.delete(id);
      }
    }
  }

  /**
   * Bojen der Extraktionszonen: je Zone ein Ring aus EXTRACTION_BUOYS Stück
   * auf dem Kreisrand. Statisch — sie kommen mit der Karte und gehen mit ihr.
   */
  setBuoys(zones: ReadonlyArray<{ id: string; x: number; y: number; radius: number }>): void {
    for (const buoy of this.buoys) buoy.view.destroy();
    this.buoys = [];
    for (const zone of zones) {
      for (let i = 0; i < EXTRACTION_BUOYS; i += 1) {
        const winkel = (i / EXTRACTION_BUOYS) * Math.PI * 2;
        const x = zone.x + Math.sin(winkel) * zone.radius;
        const y = zone.y - Math.cos(winkel) * zone.radius;
        const view = new PropView('buoy01', `${zone.id}-${i}`);
        view.attach(this.billboardLayer);
        this.buoys.push({ x, y, view });
      }
    }
  }

  /** Fester Zeitschritt. Läuft mehrfach pro Frame oder auch gar nicht. */
  simulate(dt: number): void {
    for (const entry of this.entries.values()) entry.model.simulate(dt);
  }

  /** Das eigene Boot — getauchte Fremde verschwinden, das eigene bleibt lesbar. */
  setOwnId(id: string | null): void {
    this.ownId = id;
  }

  /** Sichtlage fürs Rendern — außerhalb wird ein Fahrzeug nicht gezeichnet. */
  setVision(vision: VisionState | null): void {
    this.vision = vision;
  }

  /** Liegt ein Punkt in Sichtkreis ODER Periskop-Kegel? */
  private inVision(x: number, y: number): boolean {
    const v = this.vision;
    if (!v) return true;

    const dx = x - v.x;
    const dy = y - v.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= v.circleRadius) return true;

    if (v.coneLength > 1 && dist <= v.coneLength / Math.cos((VISION.coneHalfAngleDeg * Math.PI) / 180)) {
      // Peilung in Kursgrad (0 = Nord, Uhrzeigersinn) — Welt-y zeigt nach Süden.
      const bearing = norm360((Math.atan2(dx, -dy) * 180) / Math.PI);
      if (Math.abs(angleDelta(v.headingDegrees, bearing)) <= VISION.coneHalfAngleDeg) return true;
    }
    return false;
  }

  /** Einmal pro Frame, nachdem simuliert wurde. */
  syncViews(zoom: number, frameSeconds: number): void {
    for (const entry of this.entries.values()) {
      const isOwn = entry.model.id === this.ownId;
      // Optische Sicht: das eigene Boot immer, fremde nur innerhalb von
      // Kreis oder Kegel. Das Sonar bleibt davon unberührt — es liest die
      // MODELLE, nicht die Ansichten.
      const sichtbar = isOwn || this.inVision(entry.model.x, entry.model.y);
      entry.view.setVisible(sichtbar);
      // Unsichtbare Fahrzeuge werden nicht gezeichnet, ihre Schaumspur muss
      // aber weiter altern — sonst stünde sie beim Wiederauftauchen eingefroren
      // da, als wäre sie eben erst entstanden (siehe VesselView.age).
      if (sichtbar) entry.view.sync(entry.model, zoom, frameSeconds, isOwn);
      else entry.view.age(frameSeconds);
    }

    // Projektile durch dieselbe Sichtprüfung — ein Torpedo außerhalb von
    // Kreis und Kegel existiert im Netz (Sonar!), aber nicht auf dem Wasser.
    for (const entry of this.projectiles.values()) {
      const sichtbar = this.inVision(entry.state.x, entry.state.y);
      entry.view.setVisible(sichtbar);
      if (sichtbar) entry.view.sync(entry.state, zoom);
    }

    // Kisten ebenso; Bojen dagegen IMMER — sie markieren die Extraktionszonen
    // und sind Karteninventar wie der Kartenrand, keine Aufklärung.
    for (const entry of this.crates.values()) {
      const sichtbar = this.inVision(entry.state.x, entry.state.y);
      entry.view.setVisible(sichtbar);
      if (sichtbar) entry.view.sync(entry.state.x, entry.state.y, frameSeconds);
    }
    // Bojen liegen fest in SERVER-Koordinaten — gezeichnet wird die KOPIE,
    // die der eigenen Sicht auf dem Torus am nächsten liegt. Ohne Sichtanker
    // (Beitritt läuft noch) die Rohlage.
    const anker = this.vision;
    const { width, height } = this.mapSize;
    for (const buoy of this.buoys) {
      const bx = anker && width > 0 ? anker.x + torusDelta(anker.x, buoy.x, width) : buoy.x;
      const by = anker && height > 0 ? anker.y + torusDelta(anker.y, buoy.y, height) : buoy.y;
      buoy.view.sync(bx, by, frameSeconds);
    }

    this.drawAuswahl(zoom);
  }

  /**
   * Gestrichelte Ellipse ums angeklickte Schiff — längs des Kurses, Maße aus
   * dem Rumpf. Liegt in der Wasserebene: die Projektion kippt sie mit, wie
   * beim Vorbild. Außerhalb der Sicht verschwindet sie mit dem Schiff.
   */
  private drawAuswahl(zoom: number): void {
    const g = this.auswahl.clear();
    const id = this.selectedId;
    if (!id) return;
    const entry = this.entries.get(id);
    if (!entry || !this.inVision(entry.model.x, entry.model.y)) return;

    const dims = HULL_DIMENSIONS[entry.model.model] ?? HULL_DIMENSIONS[DEFAULT_VESSEL_MODEL];
    const rx = Math.max(dims.length * 0.62, 26 / zoom);
    const ry = Math.max(dims.beam * 2.4, rx * 0.45);
    const phi = (entry.model.rotation * Math.PI) / 180;
    // Längsachse zeigt in Kursrichtung (0° = Norden = −y), Querachse senkrecht.
    const ux = Math.sin(phi);
    const uy = -Math.cos(phi);
    const vx = Math.cos(phi);
    const vy = Math.sin(phi);

    const striche = 18;
    for (let i = 0; i < striche; i += 1) {
      const t0 = (i / striche) * Math.PI * 2;
      const schritt = ((Math.PI * 2) / striche) * 0.55;
      for (let s = 0; s <= 2; s += 1) {
        const t = t0 + (schritt * s) / 2;
        const px = entry.model.x + ux * rx * Math.cos(t) + vx * ry * Math.sin(t);
        const py = entry.model.y + uy * rx * Math.cos(t) + vy * ry * Math.sin(t);
        if (s === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
    }
    g.stroke({ color: HULL.markerColor, alpha: 0.85, pixelLine: true });
  }

  destroy(): void {
    this.auswahl.destroy();
    for (const entry of this.entries.values()) entry.view.destroy();
    this.entries.clear();
    for (const entry of this.projectiles.values()) entry.view.destroy();
    this.projectiles.clear();
    for (const entry of this.crates.values()) entry.view.destroy();
    this.crates.clear();
    for (const buoy of this.buoys) buoy.view.destroy();
    this.buoys = [];
  }
}
