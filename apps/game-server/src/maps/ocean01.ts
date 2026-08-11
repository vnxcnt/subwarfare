import { WEATHER_PRESETS } from '@subwarfare/shared';
import { defineMap } from './MapDefinition.js';

/**
 * Erste Testkarte: 10.000 × 10.000 Units offenes Wasser.
 * Spawns liegen im Norden und Süden, die Extraction-Zonen an den Flanken.
 */
export const ocean01 = defineMap({
  id: 'ocean01',
  width: 10_000,
  height: 10_000,
  spawnPoints: [
    { id: 'spawn-north', x: 5_000, y: 1_000, rotation: 180 },
    { id: 'spawn-south', x: 5_000, y: 9_000, rotation: 0 },
  ],
  exitPoints: [
    { id: 'exit-west', x: 800, y: 5_000, radius: 400 },
    { id: 'exit-east', x: 9_200, y: 5_000, radius: 400 },
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
