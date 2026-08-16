import type { ExitPoint, GameMap, Island, RoutePoint, SpawnPoint } from '@subwarfare/shared';
import { pointInPolygon, polygonBounds, segmentHitsPolygon, torusDelta } from '@subwarfare/shared';

export type { ExitPoint, GameMap, Island, SpawnPoint };

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

  // Landmassen ZUERST: die Punktprüfungen weiter unten rechnen gegen sie.
  for (const island of map.islands ?? []) {
    if (island.polygon.length < 3) {
      throw new Error(
        `Map "${map.id}": Landmasse "${island.id}" hat nur ${island.polygon.length} Punkte — ` +
          'ein Umriss braucht mindestens drei.',
      );
    }
    // Keine Insel darf die Torus-Naht überqueren: sämtliche Polygon-Mathematik
    // (Kollision, Abstandsfeld, Minimap) rechnet in der gewöhnlichen Ebene.
    // Eine Insel über der Kante wäre dort ein bandförmiges Gebilde quer über
    // die halbe Karte — und der Fehler fiele erst auf, wenn jemand mittendurch
    // fährt, ohne aufzulaufen.
    const bounds = polygonBounds(island.polygon);
    if (bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > map.width || bounds.maxY > map.height) {
      throw new Error(
        `Map "${map.id}": Landmasse "${island.id}" reicht über die Weltgrenzen hinaus ` +
          `(x ${bounds.minX.toFixed(0)}…${bounds.maxX.toFixed(0)}, ` +
          `y ${bounds.minY.toFixed(0)}…${bounds.maxY.toFixed(0)}) und überquert damit die Torus-Naht.`,
      );
    }
  }

  for (const point of [...map.spawnPoints, ...map.exitPoints]) {
    if (point.x < 0 || point.x > map.width || point.y < 0 || point.y > map.height) {
      throw new Error(`Map "${map.id}": Punkt "${point.id}" liegt außerhalb der Weltgrenzen.`);
    }
    const land = landAt(map, point.x, point.y);
    if (land) {
      throw new Error(`Map "${map.id}": Punkt "${point.id}" liegt an Land (${land.name}).`);
    }
  }

  if (map.route) {
    if (map.route.length < 2) {
      throw new Error(`Map "${map.id}": eine Frachtroute braucht mindestens zwei Punkte.`);
    }
    for (const [index, point] of map.route.entries()) {
      if (point.x < 0 || point.x > map.width || point.y < 0 || point.y > map.height) {
        throw new Error(`Map "${map.id}": Routenpunkt ${index} liegt außerhalb der Weltgrenzen.`);
      }
      const land = landAt(map, point.x, point.y);
      if (land) {
        throw new Error(`Map "${map.id}": Routenpunkt ${index} liegt an Land (${land.name}).`);
      }
    }
    // Auch die Strecken DAZWISCHEN, nicht nur die Stützpunkte: zwei Punkte im
    // Wasser mit Mallorca in der Mitte ist genau der Fehler, der beim
    // Verschieben eines Routenpunkts entsteht — und mit reiner Punktprüfung
    // fiele er erst auf, wenn die Frachter reihenweise auflaufen. Die Schleife
    // ist geschlossen (Freighters fährt Kante i → i+1 modulo n), die Strecke
    // vom letzten zum ersten Punkt zählt also mit.
    const n = map.route.length;
    for (const [index, von] of map.route.entries()) {
      const naechster = (index + 1) % n;
      const land = landOnLeg(map, von, map.route[naechster] as RoutePoint);
      if (land) {
        throw new Error(
          `Map "${map.id}": die Frachtroute kreuzt zwischen Punkt ${index} und ` +
            `${naechster} Land (${land.name}).`,
        );
      }
    }
  }

  return map;
}

/**
 * Auf welcher Landmasse liegt der Punkt? `null` heißt Wasser.
 *
 * Rein die Punktprüfung, ohne Rumpfradius und ohne Abstand zur Küste: sie fängt
 * den groben Fehler (Zone mitten auf Mallorca), nicht den knappen Abstand — der
 * bleibt Sache dessen, der die Karte entwirft und seine Punkte ausmisst.
 */
function landAt(map: GameMap, x: number, y: number): Island | null {
  for (const island of map.islands ?? []) {
    if (pointInPolygon(island.polygon, x, y)) return island;
  }
  return null;
}

/**
 * Kreuzt die Strecke zwischen zwei Routenpunkten Land? `null` heißt freie Bahn.
 *
 * Gefahren wird der kürzeste Weg auf dem TORUS — so rechnet Freighters, und auf
 * ocean01 schließt sich die Schleife genau darüber. Die Strecke ragt dabei aus
 * den Weltgrenzen heraus, die Umrisse liegen aber fest in der Ebene: geprüft
 * wird deshalb gegen alle neun Kachelversätze und nicht nur gegen den einen.
 *
 * Gerechnet wird auf der MITTELLINIE, ohne Spurversatz und ohne Rumpfbreite —
 * wie bei `landAt` ist das der grobe Fehler, nicht der knappe Abstand.
 */
function landOnLeg(map: GameMap, von: RoutePoint, bis: RoutePoint): Island | null {
  const zielX = von.x + torusDelta(von.x, bis.x, map.width);
  const zielY = von.y + torusDelta(von.y, bis.y, map.height);
  for (const island of map.islands ?? []) {
    for (const versatzX of [-map.width, 0, map.width]) {
      for (const versatzY of [-map.height, 0, map.height]) {
        const treffer = segmentHitsPolygon(
          island.polygon,
          von.x + versatzX,
          von.y + versatzY,
          zielX + versatzX,
          zielY + versatzY,
        );
        if (treffer) return island;
      }
    }
  }
  return null;
}
