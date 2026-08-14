import { WEATHER_PRESETS } from '@subwarfare/shared';
import { defineMap } from './MapDefinition.js';

/**
 * Erste Karte: 25.000 × 25.000 Units offenes Wasser — als TORUS. Es gibt
 * keinen Rand: wer über eine Kante fährt, kommt auf der Gegenseite wieder
 * herein (Wrap in World.update). Spawns liegen im Norden und Süden, die
 * Extraktionszonen oben links und unten rechts.
 */
export const ocean01 = defineMap({
  id: 'ocean01',
  width: 25_000,
  height: 25_000,
  spawnPoints: [
    { id: 'spawn-north', x: 12_500, y: 2_500, rotation: 180 },
    { id: 'spawn-south', x: 12_500, y: 22_500, rotation: 0 },
  ],
  // Ein Viertel der Kantenlänge von der (gedachten) Ecke entfernt: weit genug
  // von den Spawns, dass eine Extraktion eine Fahrt durchs offene Wasser ist.
  // Acht Sekunden im Kreis sichern den Einsatz (EXTRACTION_SECONDS, shared);
  // der Client markiert jeden Kreis mit sechs Bojen.
  exitPoints: [
    { id: 'exit-nw', x: 6_250, y: 6_250, radius: 400 },
    { id: 'exit-se', x: 18_750, y: 18_750, radius: 400 },
  ],
  // Frachtroute von oben rechts nach unten links, eine sanfte S-Kurve durch
  // die Kartenmitte — bewusst fern beider Extraktionszonen (> 8,5 km). Auf dem
  // Torus schließt sie sich über die Ecke: vom letzten Punkt geht es auf
  // kürzestem Weg über die Naht zurück zum ersten (Kreuzung exakt in der
  // Kartenecke). Frachter verkehren darauf endlos in beiden Richtungen.
  route: [
    { x: 22_500, y: 2_500 },
    { x: 19_300, y: 4_300 },
    { x: 16_500, y: 6_500 },
    { x: 14_300, y: 9_300 },
    { x: 12_500, y: 12_500 },
    { x: 10_700, y: 15_700 },
    { x: 8_500, y: 18_500 },
    { x: 5_700, y: 20_700 },
    { x: 2_500, y: 22_500 },
  ],
});

/**
 * Wetterlage dieser Karte. Bewusst NEBEN der Geometrie: die Karte ist statisch,
 * das Wetter ist ein Zustand — und je Karte (später auch je Partie) ein anderer.
 *
 * „Nordatlantik" ist die Stimmung des Vorbilds: bedeckt, grau, rau. Zum
 * Ausprobieren stehen in `WEATHER_PRESETS` auch klarer_tag, sturm, daemmerung
 * und nacht; einzelne Werte lassen sich hier ebenso überschreiben.
 */
export const ocean01Weather = WEATHER_PRESETS.nordatlantik;
