import type { VesselModel } from '../types/Player.js';

/**
 * Loot und Extraktion — der Kern der Einsatzschleife.
 *
 * Ein versenktes Schiff hinterlässt eine Kiste. Wer sie überfährt, TRÄGT den
 * Loot — er gehört ihm damit noch nicht: gutgeschrieben wird erst, wer sich
 * acht Sekunden in einer Extraktionszone hält. Wer vorher versenkt wird, lässt
 * alles Getragene wieder fallen; wer die Karte über den Knopf verlässt oder
 * die Verbindung verliert, verliert Loot UND mitgebrachte Ausrüstung.
 *
 * Die Werte hier sind Spielregeln, keine Darstellung — sie leben in shared,
 * weil Server (Rechnung) und Client (Anzeige) dieselben Zahlen brauchen.
 */

/** Sekunden, die man sich ununterbrochen in der Zone halten muss. */
export const EXTRACTION_SECONDS = 8;

/**
 * Aufsammelradius in Metern, gerechnet von der Schiffsmitte zur Kiste.
 * Großzügiger als die Rumpfbreite: eine Kiste punktgenau treffen zu müssen
 * wäre bei 125 ms Anzeigelatenz reine Geduldsprobe.
 */
export const LOOT_PICKUP_RADIUS = 45;

/** Grafik-Kennung der Kiste — der Client wählt darüber den Atlas. */
export const LOOT_CRATE_MODEL = 'loot01';

/** Bojen je Extraktionszone — rein darstellend, der Kreis selbst zählt. */
export const EXTRACTION_BUOYS = 6;

/**
 * Was ein NPC beim Untergang fallen lässt, in Coins.
 *
 * Vorläufige Zahlen bis der Beutepool steht (Items statt nur Coins). Was hier
 * fehlt, lässt nichts fallen. Spieler stehen bewusst NICHT in dieser Liste —
 * ihr Drop ist die Einsatzgebühr ihres Schiffs plus alles, was sie trugen.
 */
export const NPC_LOOT: Partial<Record<VesselModel, number>> = {
  /** Containerschiff. */
  tanker01: 50,
  /** Speedboot. */
  speedster01: 10,
  /** Yacht. */
  yachtgun01: 25,
};
