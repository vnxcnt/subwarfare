import type { VesselModel } from '../types/Player.js';

/**
 * Torpedorohre.
 *
 * Das Vorbild (Silent Wolves, 2009) machte aus dem Torpedoschuss eine
 * Entscheidungskette statt eines Knopfdrucks: Rohre werden von Hand GELADEN,
 * einzeln SCHARF geschaltet, und der Spieler bestimmt, aus welchen Rohren und
 * wie vielen zugleich geschossen wird. Genau das bilden diese Werte ab.
 *
 * Nur der TORPEDO läuft über Rohre. Geschütz, Wasserbombe und Täuschkörper
 * behalten ihre einfache Rohr-Sperre — ein Deckgeschütz hat kein Torpedorohr,
 * und drei Ladezustände für jede Waffe wären Buchhaltung ohne Spielwert.
 */

/**
 * Einbaulage eines Rohrs. Sie bestimmt die Abschussrichtung und damit auch,
 * welche Rohre eine gezielte Peilung überhaupt bedienen können.
 */
export type TubePosition = 'bug' | 'heck' | 'backbord' | 'steuerbord';

/** Kurzbeschriftung für die Rohr-Anzeige im HUD. */
export const TUBE_LABELS: Record<TubePosition, string> = {
  bug: 'BUG',
  heck: 'HECK',
  backbord: 'BB',
  steuerbord: 'STB',
};

/**
 * Rohrbestückung je Schiff, in Anzeige-Reihenfolge.
 *
 * U-Boote schießen aus Bug und Heck, Überwasserschiffe werfen über die Seiten
 * ab — das deckt sich mit den Sektoren, die schon für das gezielte Feuern
 * gelten. Ein Modell ohne Eintrag führt keine Torpedos (Fregatten, NPCs).
 */
export const TUBE_LAYOUTS: Partial<Record<VesselModel, TubePosition[]>> = {
  submarine01: ['bug', 'bug'],
  submarine02: ['bug', 'bug', 'heck'],
  destroyer01: ['backbord', 'backbord', 'steuerbord', 'steuerbord'],
  destroyer02: ['backbord', 'backbord', 'backbord', 'steuerbord', 'steuerbord', 'steuerbord'],
  destroyer03: ['backbord', 'backbord', 'steuerbord', 'steuerbord'],
  submarine03: ['bug', 'bug', 'bug', 'heck', 'heck'],
  submarine04: ['bug', 'bug', 'bug', 'heck'],
};

export function tubeLayoutFor(model: VesselModel): TubePosition[] {
  return TUBE_LAYOUTS[model] ?? [];
}

export const TUBE = {
  /**
   * Ladezeit eines Rohrs in Sekunden. Sie IST die Feuerrate des Torpedos —
   * eine zusätzliche Sperre gäbe es doppelt.
   */
  reloadSeconds: 8,
  /**
   * Winkelabstand benachbarter Torpedos einer Salve in Grad. Ein Fächer deckt
   * einen Korridor ab, statt dreimal dieselbe Linie zu treffen — das macht die
   * Salve zu etwas anderem als einem dicken Einzelschuss.
   */
  spreadDeg: 2.5,
} as const;

/** Ladezustand eines Rohrs. */
export type TubeStatus = 'leer' | 'laedt' | 'geladen';

/**
 * Rohr-Zustand, wie ihn der Besitzer sieht. Bewusst NUR im `own`-Ereignis:
 * wie viele Rohre der Gegner scharf hat, ist Aufklärung.
 */
export interface TubeState {
  position: TubePosition;
  status: TubeStatus;
  /** Ladefortschritt 0..1 — nur bei `laedt` aussagekräftig. */
  progress: number;
  /** Scharf geschaltet: feuert bei der nächsten Salve mit. */
  armed: boolean;
}

/**
 * Peilung, in die ein Rohr dieser Lage schießt — relativ zum Kurs des Schiffs.
 */
export function tubeBearing(position: TubePosition, courseDegrees: number): number {
  const offset =
    position === 'bug' ? 0 : position === 'heck' ? 180 : position === 'backbord' ? -90 : 90;
  return (((courseDegrees + offset) % 360) + 360) % 360;
}

/**
 * Fächer-Versätze für `count` gleichzeitig laufende Torpedos, zentriert um die
 * Zielpeilung. Ein einzelner Torpedo läuft exakt auf die Peilung.
 */
export function salvoSpread(count: number): number[] {
  const mitte = (count - 1) / 2;
  return Array.from({ length: count }, (_, i) => (i - mitte) * TUBE.spreadDeg);
}
