/**
 * Ein Einstiegspunkt in eine Map. Spieler betreten den Server ausschließlich
 * über einen Spawnpunkt.
 */
export interface SpawnPoint {
  id: string;
  /** Weltkoordinate in Map-Units. */
  x: number;
  /** Weltkoordinate in Map-Units. */
  y: number;
  /** Startausrichtung in Grad. 0 = Norden, im Uhrzeigersinn steigend. */
  rotation: number;
}
