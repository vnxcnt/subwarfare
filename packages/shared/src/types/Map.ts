import type { ExitPoint } from './ExitPoint.js';
import type { SpawnPoint } from './SpawnPoint.js';

/** Eindeutige Kennung einer Map, z. B. `ocean01`. */
export type MapId = string;

/** Stützpunkt der Frachtroute in Map-Units. */
export interface RoutePoint {
  x: number;
  y: number;
}

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
  /**
   * Frachtroute als Polylinie. Auf Torus-Karten schließt sie sich über die
   * Naht zur Schleife: vom letzten Punkt geht es auf kürzestem Weg (über die
   * Kante) zurück zum ersten. NPC-Frachter verkehren nur hierauf; der Client
   * zeichnet die Linie auf der Minimap.
   */
  route?: RoutePoint[];
}
