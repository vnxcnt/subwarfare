/**
 * Eine Extraction-/Exit-Zone. Wer sich innerhalb des Radius befindet, kann den
 * Server regulär verlassen.
 */
export interface ExitPoint {
  id: string;
  /** Weltkoordinate des Zonenmittelpunkts in Map-Units. */
  x: number;
  /** Weltkoordinate des Zonenmittelpunkts in Map-Units. */
  y: number;
  /** Radius der Zone in Map-Units. */
  radius: number;
}
