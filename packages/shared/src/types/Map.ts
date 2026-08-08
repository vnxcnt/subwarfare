import type { ExitPoint } from './ExitPoint.js';
import type { SpawnPoint } from './SpawnPoint.js';

/** Eindeutige Kennung einer Map, z. B. `ocean01`. */
export type MapId = string;

/**
 * Statische Definition einer Spielwelt. Heißt bewusst `GameMap`, damit sie sich
 * nicht mit dem eingebauten `Map` beißt.
 *
 * Der Ursprung (0,0) liegt oben links, x wächst nach Osten, y nach Süden.
 */
export interface GameMap {
  id: MapId;
  /** Breite der Welt in Map-Units. */
  width: number;
  /** Höhe der Welt in Map-Units. */
  height: number;
  spawnPoints: SpawnPoint[];
  exitPoints: ExitPoint[];
}
