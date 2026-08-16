import type { WeatherState } from '@subwarfare/shared';
import type { GameMap } from './MapDefinition.js';
import { ocean01, ocean01Weather } from './ocean01.js';
import { ocean04, ocean04Weather } from './ocean04.js';

/**
 * Eine Karte samt ihrer Wetterlage. Beides gehört zusammen ausgeliefert: die
 * Geometrie ist statisch, das Wetter ist der Zustand, in dem sie gefahren wird —
 * eine Karte ohne ihre Lage wäre nur die halbe Wahrheit über die Welt.
 */
export interface MapEntry {
  map: GameMap;
  weather: WeatherState;
}

/**
 * Alle Karten, die dieser Server fahren kann. Welche es wird, entscheidet
 * MAP_ID beim Start — je Karte ein eigener Prozess mit eigenem Port.
 */
const MAPS = {
  ocean01: { map: ocean01, weather: ocean01Weather },
  ocean04: { map: ocean04, weather: ocean04Weather },
} as const satisfies Record<string, MapEntry>;

export type KnownMapId = keyof typeof MAPS;

/**
 * Karte und Wetter zu einer Kennung — oder gar nichts.
 *
 * Es gibt bewusst KEINE Rückfallkarte: ein Server, der wegen eines Tippfehlers
 * in MAP_ID stillschweigend ocean01 fährt, verteilt Spieler auf eine Welt, die
 * niemand angefordert hat — und niemand merkt es, bis die Lobby ins Leere
 * schickt. Ein Prozess, der gar nicht erst hochkommt, ist der ehrlichere Fehler.
 */
export function mapById(id: string): MapEntry {
  // Erst `hasOwn`, dann zugreifen: ein MAP_ID von „toString" oder „constructor"
  // fände sonst ein Mitglied der Objekt-Urahnen, käme als vermeintlicher
  // Eintrag durch — und der Prozess stürbe erst tief in der Welt-Erzeugung an
  // einer undefinierten Karte statt hier mit klarer Ansage.
  const eintrag = Object.hasOwn(MAPS, id)
    ? (MAPS as Record<string, MapEntry | undefined>)[id]
    : undefined;
  if (!eintrag) {
    throw new Error(
      `Unbekannte Karte "${id}" in MAP_ID. Bekannt sind: ${Object.keys(MAPS).join(', ')}.`,
    );
  }
  return eintrag;
}
