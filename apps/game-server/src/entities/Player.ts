import type { PlayerId, PlayerState, SpawnPoint } from '@subwarfare/shared';

/**
 * Ein Spieler samt seinem Schiff/U-Boot in der Welt.
 * Hält bewusst nur Zustand — die Simulation liegt in `World`.
 */
export class Player {
  readonly id: PlayerId;
  name: string;

  /** Weltkoordinate in Map-Units. */
  x = 0;
  /** Weltkoordinate in Map-Units. */
  y = 0;
  /** Blickrichtung in Grad. 0 = Norden, im Uhrzeigersinn steigend. */
  rotation = 0;
  /** Aktuelle Geschwindigkeit in Map-Units pro Sekunde. */
  speed = 0;

  constructor(id: PlayerId, name: string) {
    this.id = id;
    this.name = name;
  }

  /** Setzt den Spieler auf einen Spawnpunkt. */
  placeAt(spawn: SpawnPoint): void {
    this.x = spawn.x;
    this.y = spawn.y;
    this.rotation = spawn.rotation;
    this.speed = 0;
  }

  /** Netzwerk-Repräsentation für State-Updates. */
  toState(): PlayerState {
    return {
      id: this.id,
      name: this.name,
      x: this.x,
      y: this.y,
      rotation: this.rotation,
      speed: this.speed,
    };
  }
}
