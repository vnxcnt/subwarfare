import type { ExitPoint, GameMap, PlayerId, SpawnPoint } from '@subwarfare/shared';
import { DESTROYER, Vessel } from '@subwarfare/shared';

/**
 * Die laufende Instanz einer Karte: statische Definition plus alle Fahrzeuge,
 * die gerade darin unterwegs sind — Spieler wie Bots.
 *
 * Diese Welt ist die **Quelle der Wahrheit**. Was davon ein Client zu sehen
 * bekommt, entscheidet die Sichtbarkeitsfilterung im GameServer; Befehle laufen
 * ausschließlich über `orderMoveTo` und `setTelegraph` der Fahrzeuge, und beide
 * Werte klemmt der Aufrufer vorher.
 */
export class World {
  readonly map: GameMap;

  private readonly vessels = new Map<PlayerId, Vessel>();
  private nextSpawnIndex = 0;

  constructor(map: GameMap) {
    this.map = map;
  }

  get count(): number {
    return this.vessels.size;
  }

  /** Legt ein Fahrzeug auf dem nächsten freien Spawnpunkt an. */
  spawn(id: PlayerId, name: string): Vessel {
    const point = this.pickSpawnPoint();
    const vessel = new Vessel({ id, name, x: point.x, y: point.y, rotation: point.rotation }, DESTROYER);
    this.vessels.set(id, vessel);
    return vessel;
  }

  /** Legt ein Fahrzeug an einer bestimmten Stelle an — für Bots. */
  spawnAt(id: PlayerId, name: string, x: number, y: number, rotation: number): Vessel {
    const vessel = new Vessel({ id, name, x, y, rotation }, DESTROYER);
    this.vessels.set(id, vessel);
    return vessel;
  }

  remove(id: PlayerId): boolean {
    return this.vessels.delete(id);
  }

  get(id: PlayerId): Vessel | undefined {
    return this.vessels.get(id);
  }

  all(): IterableIterator<Vessel> {
    return this.vessels.values();
  }

  /** Reihum der nächste Spawnpunkt, damit sich Spieler nicht stapeln. */
  pickSpawnPoint(): SpawnPoint {
    const spawn = this.map.spawnPoints[this.nextSpawnIndex % this.map.spawnPoints.length];
    this.nextSpawnIndex += 1;
    return spawn as SpawnPoint;
  }

  /** Begrenzt einen Punkt auf die Karte. Gilt für jeden Befehl von außen. */
  clampToMap(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.min(Math.max(x, 0), this.map.width),
      y: Math.min(Math.max(y, 0), this.map.height),
    };
  }

  /** Exit-Zone, in der sich der Punkt gerade befindet — sonst `undefined`. */
  findExitPointAt(x: number, y: number): ExitPoint | undefined {
    return this.map.exitPoints.find((exit) => {
      const dx = exit.x - x;
      const dy = exit.y - y;
      return dx * dx + dy * dy <= exit.radius * exit.radius;
    });
  }

  /** Ein Simulationsschritt mit festem `dt` für alle Fahrzeuge. */
  update(deltaSeconds: number): void {
    for (const vessel of this.vessels.values()) vessel.simulate(deltaSeconds);
  }
}
