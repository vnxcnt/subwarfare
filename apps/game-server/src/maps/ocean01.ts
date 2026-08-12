import { WEATHER_PRESETS } from '@subwarfare/shared';
import { defineMap } from './MapDefinition.js';

/**
 * Erste Testkarte: 10.000 × 10.000 Units offenes Wasser.
 * Spawns liegen im Norden und Süden, die Extraktionszonen oben links und
 * oben rechts.
 */
export const ocean01 = defineMap({
  id: 'ocean01',
  width: 10_000,
  height: 10_000,
  spawnPoints: [
    { id: 'spawn-north', x: 5_000, y: 1_000, rotation: 180 },
    { id: 'spawn-south', x: 5_000, y: 9_000, rotation: 0 },
  ],
  // Bewusst NICHT direkt am Rand (2000 statt 800 von der Kante): wer
  // extrahieren will, soll durchs offene Wasser, nicht an der Wand entlang.
  // Acht Sekunden im Kreis sichern den Einsatz (EXTRACTION_SECONDS, shared);
  // der Client markiert jeden Kreis mit sechs Bojen.
  exitPoints: [
    { id: 'exit-nw', x: 2_000, y: 2_000, radius: 400 },
    { id: 'exit-ne', x: 8_000, y: 2_000, radius: 400 },
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
