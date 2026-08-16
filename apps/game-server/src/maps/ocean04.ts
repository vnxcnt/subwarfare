import { WEATHER_PRESETS } from '@subwarfare/shared';
import { defineMap } from './MapDefinition.js';
import { OCEAN04_ISLANDS } from './ocean04-islands.js';

/**
 * Zweite Karte: 30.000 × 30.000 Units Mittelmeer mit den BALEAREN — Mallorca in
 * der Mitte, Menorca im Nordosten, Ibiza im Südwesten. Wie ocean01 ein Torus:
 * wer über eine Kante fährt, kommt auf der Gegenseite herein. Der breite
 * Wasserrand (4,9 km im Westen und Osten, 9,4 km im Norden und Süden) ist
 * deshalb keine Verschwendung, sondern der Puffer, der die Inseln von der Naht
 * fernhält — die gesamte Polygon-Mathematik rechnet in der gewöhnlichen Ebene.
 *
 * Alle Punkte hier sind GEMESSEN, nicht geschätzt: gegen OCEAN04_ISLANDS mit
 * signedDistanceToPolygon, torus-bewusst (jeder Kandidat auch an den acht
 * Nachbarkacheln geprüft). Die Zahl hinter einem Punkt ist sein Abstand zur
 * nächsten Küste in Metern. Wer einen Punkt verschiebt, misst ihn neu — mit
 * bloßem Auge sieht eine Zone auf der Minimap noch im Wasser aus, während sie
 * längst auf einer Landzunge sitzt.
 */
export const ocean04 = defineMap({
  id: 'ocean04',
  width: 30_000,
  height: 30_000,
  islands: OCEAN04_ISLANDS,
  // Die vier Zufahrten des Archipels, alle weit draußen im offenen Wasser: von
  // hier aus ist jede Insel eine Fahrt und keine Ankunft.
  spawnPoints: [
    { id: 'spawn-nord', x: 15_000, y: 3_500, rotation: 180 }, // 6.439 m
    { id: 'spawn-ost', x: 28_000, y: 19_000, rotation: 270 }, // 6.919 m — nächste Küste ist Ibiza ÜBER die Naht
    { id: 'spawn-sued', x: 15_000, y: 26_500, rotation: 0 }, // 8.664 m
    { id: 'spawn-west', x: 2_500, y: 13_500, rotation: 90 }, // 5.547 m
  ],
  // Zwei Zonen, 10,7 km auseinander, 7,3 bzw. 7,5 km vom nächsten Spawn —
  // eine Extraktion bleibt damit eine Fahrt und keine Kehrtwende. Radius 400
  // wie auf ocean01; die Zahl ist der Abstand des MITTELPUNKTS zur Küste, es
  // liegt also auch außerhalb des Zonenkreises noch Wasser (686 m bzw.
  // 1.635 m). Beide halten außerdem gut 2,5 km Abstand zur Frachtroute — wie
  // auf ocean01 sollen Frachterjagd und Extraktion getrennte Unternehmungen
  // bleiben, und ein Tankerstrom mitten durch die Zone wäre bei acht Sekunden
  // Zonenzeit schlicht eine Rammfahrt.
  exitPoints: [
    // In der Straße von Menorca, zwischen Mallorcas Nordostkap und Menorcas
    // Westspitze: die Enge der Karte, und man wird dort gesehen.
    { id: 'exit-menorca-strasse', x: 19_400, y: 9_300, radius: 400 }, // 1.086 m
    { id: 'exit-mallorca-sued', x: 14_900, y: 19_000, radius: 400 }, // 2.035 m
  ],
  // Handelsroute im Uhrzeigersinn: nördlich an Mallorca entlang, außen um
  // Menorca herum, quer durch die offene See im Südosten zurück nach Westen und
  // durch die STRASSE VON IBIZA wieder nach Norden. Die Schleife schließt sich
  // ohne die Naht zu berühren — Mallorca und Menorca liegen innerhalb, Ibiza
  // außerhalb, weshalb der Verkehr genau einmal durch eine echte Enge muss.
  //
  // Die Straße von Menorca bleibt bewusst FREI: für Frachter ist sie zu eng
  // (in ihrer Mitte keine 700 m Wasser), und dort liegt die Extraktionszone.
  //
  // Kein Routenpunkt liegt näher als 1.257 m an einer Küste, und auch entlang
  // der Strecken sinkt der Abstand nirgends unter 1.124 m (Abtastung alle 25 m,
  // engste Stelle bei 9.598/16.789 in der Straße von Ibiza). Der Vorrat ist
  // Absicht: die Frachter fahren nicht AUF der Linie, sondern bis zu 350 m
  // seitlich versetzt (SPUR_MAX in Freighters, Gegenverkehr auf eigener Spur),
  // und der Rumpf ist selbst noch 180 m lang.
  route: [
    { x: 12_500, y: 6_600 }, // 4.454 m
    { x: 17_200, y: 6_300 }, // 3.217 m
    { x: 21_800, y: 6_800 }, // 2.871 m
    { x: 25_600, y: 8_200 }, // 2.590 m
    { x: 27_800, y: 11_800 }, // 2.722 m
    { x: 26_200, y: 16_000 }, // 3.443 m
    { x: 21_500, y: 20_300 }, // 4.589 m
    { x: 16_000, y: 22_200 }, // 4.252 m
    { x: 11_800, y: 20_400 }, // 3.746 m
    { x: 9_300, y: 16_300 }, // 1.257 m — Straße von Ibiza
    { x: 8_500, y: 13_800 }, // 1.543 m — Westküste Mallorcas
    { x: 9_800, y: 9_800 }, // 3.450 m
  ],
});

/**
 * Wetterlage dieser Karte — wie bei ocean01 bewusst NEBEN der Geometrie.
 *
 * Mittelmeer statt Nordatlantik: hoher Mittag, kaum Wolken, ruhige See. Der
 * niedrige Seegang ist hier nicht nur Stimmung, sondern Spielgefühl — er lässt
 * die Sonarreichweite oben (WEATHER_EFFECTS dämpft sie mit dem Seegang) und
 * macht das Auftauchen in einer Enge zur echten Entscheidung.
 */
export const ocean04Weather = WEATHER_PRESETS.klarer_tag;
