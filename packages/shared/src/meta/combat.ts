import type { VesselModel } from '../types/Player.js';

/**
 * Kampfwerte — Waffen und Rumpfmaße.
 *
 * Liegt in shared, weil beide Seiten dieselben Zahlen brauchen: der Server
 * rechnet damit autoritativ (Abschuss, Kollision, Schaden), der Client leitet
 * Anzeigen daraus ab (Munitionsleiste, Nachladebalken). Eine zweite Tabelle im
 * Client wäre eine zweite Wahrheit.
 */

/** Der Standard-Torpedo (Grafik-Atlas `torpedo01`). */
export const TORPEDO = {
  /** Waffen-Kennung in `armament` der ships-Tabelle. */
  weapon: 'torpedo',
  /** Grafik-Kennung — der Client wählt darüber den Richtungs-Atlas. */
  model: 'torpedo01',
  /**
   * Laufgeschwindigkeit in m/s. Muss über der Höchstfahrt des schnellsten
   * Schiffs liegen (speedster01: 1,3 × 30 = 39 m/s), sonst wäre Weglaufen
   * die beste Torpedoabwehr.
   */
  speed: 45,
  /** Laufstrecke in Metern — danach ist er ein Blindgänger und verschwindet. */
  rangeMetres: 2_200,
  damage: 150,
  /** Rohrwechsel: Sperre zwischen zwei Schüssen in Sekunden. */
  cooldownSeconds: 3,
  /** Munitionsvorrat je Einsatz. Aufmunitionierung kommt später. */
  capacity: 12,
  /** Trefferradius des Torpedos selbst (kommt zum halben Beam des Ziels dazu). */
  hitRadius: 1.5,
} as const;

/**
 * Rumpfmaße in Metern für die Kollision: der Rumpf ist eine KAPSEL — Strecke
 * der Länge (length − beam) längs des Kurses, verdickt um beam/2. Die Längen
 * sind dieselben, mit denen der Client die Billboards skaliert; driften die
 * beiden auseinander, explodieren Torpedos sichtbar neben dem Schiff.
 */
export const HULL_DIMENSIONS: Record<VesselModel, { length: number; beam: number }> = {
  fregatte01: { length: 140, beam: 25 },
  yachtgun01: { length: 55, beam: 14 },
  submarine01: { length: 110, beam: 13 },
  speedster01: { length: 18, beam: 6 },
};

/** Wartezeit bis zum Wiedereinstieg nach einer Versenkung, in Sekunden. */
export const RESPAWN_SECONDS = 5;

/** Bots kehren langsamer zurück — die Karte soll nicht sofort wieder voll sein. */
export const BOT_RESPAWN_SECONDS = 10;
