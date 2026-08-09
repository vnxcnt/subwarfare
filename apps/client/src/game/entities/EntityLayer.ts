import type { Container } from 'pixi.js';
import type { Vessel } from '@subwarfare/shared';
import { VesselView } from './VesselView';

interface Entry {
  model: Vessel;
  view: VesselView;
}

/**
 * Registry aller Fahrzeuge samt ihrer Darstellung. Besitzt den Container, den
 * sie von außen bekommt — dasselbe Muster wie `Ocean`, damit `World` weder
 * `Vessel` noch `VesselView` kennen muss.
 */
export class EntityLayer {
  private readonly layer: Container;
  private readonly entries = new Map<string, Entry>();

  constructor(layer: Container) {
    this.layer = layer;
  }

  get count(): number {
    return this.entries.size;
  }

  spawn(model: Vessel): Vessel {
    this.remove(model.id);

    const view = new VesselView();
    view.attach(this.layer);
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

  /** Fester Zeitschritt. Läuft mehrfach pro Frame oder auch gar nicht. */
  simulate(dt: number): void {
    for (const entry of this.entries.values()) entry.model.simulate(dt);
  }

  /** Einmal pro Frame, nachdem simuliert wurde. */
  syncViews(zoom: number, frameSeconds: number): void {
    for (const entry of this.entries.values()) entry.view.sync(entry.model, zoom, frameSeconds);
  }

  destroy(): void {
    for (const entry of this.entries.values()) entry.view.destroy();
    this.entries.clear();
  }
}
