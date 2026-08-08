import type { ExitPoint, GameMap, PlayerId, PlayerState, SpawnPoint } from '@subwarfare/shared';
import { Player } from '../entities/Player.js';

/**
 * Die laufende Instanz einer Map: statische Definition plus alle Spieler, die
 * gerade darin unterwegs sind. Enthält noch keine Simulation — `update()` ist
 * der Platzhalter, in dem Bewegung und Kollision später landen.
 */
export class World {
  readonly map: GameMap;

  private readonly players = new Map<PlayerId, Player>();
  private nextSpawnIndex = 0;

  constructor(map: GameMap) {
    this.map = map;
  }

  get playerCount(): number {
    return this.players.size;
  }

  addPlayer(player: Player): void {
    player.placeAt(this.pickSpawnPoint());
    this.players.set(player.id, player);
  }

  removePlayer(id: PlayerId): boolean {
    return this.players.delete(id);
  }

  getPlayer(id: PlayerId): Player | undefined {
    return this.players.get(id);
  }

  /** Zustand aller Spieler für ein State-Update. */
  snapshot(): PlayerState[] {
    return [...this.players.values()].map((player) => player.toState());
  }

  /** Reihum der nächste Spawnpunkt, damit sich Spieler nicht stapeln. */
  pickSpawnPoint(): SpawnPoint {
    const spawn = this.map.spawnPoints[this.nextSpawnIndex % this.map.spawnPoints.length];
    this.nextSpawnIndex += 1;
    return spawn;
  }

  /** Exit-Zone, in der sich der Punkt gerade befindet — sonst `undefined`. */
  findExitPointAt(x: number, y: number): ExitPoint | undefined {
    return this.map.exitPoints.find((exit) => {
      const dx = exit.x - x;
      const dy = exit.y - y;
      return dx * dx + dy * dy <= exit.radius * exit.radius;
    });
  }

  /**
   * Ein Simulationsschritt.
   * @param _deltaSeconds vergangene Zeit seit dem letzten Tick in Sekunden.
   */
  update(_deltaSeconds: number): void {
    // Bewegung, Kollision und Extraction folgen später.
  }
}
