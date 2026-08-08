import type { ExitPoint, GameMap, SpawnPoint } from '@subwarfare/shared';

export type { ExitPoint, GameMap, SpawnPoint };

/**
 * Nimmt eine Map-Definition entgegen, prüft sie flach auf Plausibilität und gibt
 * sie unverändert zurück. Map-Dateien bleiben dadurch rein deklarativ, Tippfehler
 * fallen aber schon beim Serverstart auf statt erst im Spiel.
 */
export function defineMap(map: GameMap): GameMap {
  if (map.width <= 0 || map.height <= 0) {
    throw new Error(`Map "${map.id}": width und height müssen größer als 0 sein.`);
  }
  if (map.spawnPoints.length === 0) {
    throw new Error(`Map "${map.id}": mindestens ein Spawnpunkt ist erforderlich.`);
  }
  if (map.exitPoints.length === 0) {
    throw new Error(`Map "${map.id}": mindestens eine Exit-Zone ist erforderlich.`);
  }

  for (const point of [...map.spawnPoints, ...map.exitPoints]) {
    if (point.x < 0 || point.x > map.width || point.y < 0 || point.y > map.height) {
      throw new Error(`Map "${map.id}": Punkt "${point.id}" liegt außerhalb der Weltgrenzen.`);
    }
  }

  return map;
}
