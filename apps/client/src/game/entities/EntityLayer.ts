import type { Container } from 'pixi.js';
import type { ProjectileState, Vessel } from '@subwarfare/shared';
import { angleDelta, norm360 } from '@subwarfare/shared';
import { VISION } from '../../config';
import { ProjectileView } from './ProjectileView';
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
  private ownId: string | null = null;
  private vision: VisionState | null = null;

  constructor(waterLayer: Container, billboardLayer: Container) {
    this.waterLayer = waterLayer;
    this.billboardLayer = billboardLayer;
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
      if (sichtbar) entry.view.sync(entry.model, zoom, frameSeconds, isOwn);
    }

    // Projektile durch dieselbe Sichtprüfung — ein Torpedo außerhalb von
    // Kreis und Kegel existiert im Netz (Sonar!), aber nicht auf dem Wasser.
    for (const entry of this.projectiles.values()) {
      const sichtbar = this.inVision(entry.state.x, entry.state.y);
      entry.view.setVisible(sichtbar);
      if (sichtbar) entry.view.sync(entry.state, zoom);
    }
  }

  destroy(): void {
    for (const entry of this.entries.values()) entry.view.destroy();
    this.entries.clear();
    for (const entry of this.projectiles.values()) entry.view.destroy();
    this.projectiles.clear();
  }
}
