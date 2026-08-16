import type { GameMap, Island } from '@subwarfare/shared';
import { Assets, BufferImageSource, Texture } from 'pixi.js';

import grasUrl from '../assets/terrain/grass01.webp';
import sandUrl from '../assets/terrain/sand01.webp';

/**
 * Das Abstandsfeld der Küste — die Grundlage der gesamten Landdarstellung.
 *
 * Der Ozean-Shader braucht für jeden Bildpunkt EINE Zahl: wie weit ist von hier
 * bis zur Wasserlinie, und liege ich davor oder dahinter? Aus dieser Zahl fallen
 * Flachwasser, Brandung, nasser Sand, Strand und Bewuchs heraus, ohne dass eine
 * einzige Kante gezeichnet werden müsste.
 *
 * Es gibt bewusst KEINE gebackene Datei dazu. Die Umrisse in `map.islands` sind
 * die einzige Wahrheit über die Form — der Server kollidiert dagegen, die
 * Minimap zeichnet sie, und dieses Feld wird beim Kartenladen daraus gerechnet.
 * Ein zweites Asset wäre eine zweite Wahrheit, die beim ersten Formwechsel
 * auseinanderläuft.
 *
 * Der Bau kostet ein paar hundert Millisekunden und läuft genau einmal, im
 * Ladebildschirm.
 */

/**
 * Kantenlänge des Feldes in Zellen, bezogen auf die BREITERE Kartenachse.
 * Bei 30 km Karte sind das 14,6 m je Zelle — fein genug, dass die Wasserlinie
 * (Übergang über ~16 m) nicht als Treppe erkennbar wird, und grob genug, dass
 * der Bau im Ladebildschirm untergeht.
 */
const FELD_KANTE = 2048;

/**
 * Abstandsbereich, den die Textur trägt: ±1500 m. Alles darüber wird gekappt —
 * der weiteste Effekt (Flachwasser) reicht 430 m, der Rest liegt innerhalb von
 * 150 m um die Wasserlinie.
 *
 * ⚠️ Der Bereich hängt an der KODIERUNG: 16 Bit über 3000 m ergeben 4,6 cm je
 * Stufe. Mit 8 Bit wären es 11,7 m — bei einer 16 m breiten Wasserlinie also
 * anderthalb Stufen für den ganzen Übergang, und der Strand bekäme einen
 * gestuften Saum.
 */
const REICHWEITE = 1500;

/** Rechenwert für „unendlich weit weg" in der Distanztransformation. */
const UNENDLICH = 1e20;

/** Das fertige Feld, so wie der Ozean-Shader es braucht. */
export interface IslandField {
  /** RG-kodierter Abstand, punktgenau abzutasten (siehe `buildIslandField`). */
  texture: Texture;
  /** Feldgröße in Zellen — der Shader mischt die vier Nachbarn selbst. */
  breite: number;
  hoehe: number;
  /** Abstandsbereich in Metern, auf den 0..1 der Textur abbildet. */
  reichweite: number;
}

/** Die beiden Bodentexturen der Küste. */
export interface TerrainTextures {
  sand: Texture;
  gras: Texture;
}

/**
 * Die Inseln der zuletzt geladenen Karte.
 *
 * Liegt hier und nicht im HUD-Zustand, weil die Minimap der einzige Leser ist
 * und die Umrisse ohnehin schon durch dieses Modul laufen. Die Minimap wird
 * beim Öffnen neu aufgebaut und liest den Wert dabei einmal — es braucht keine
 * Reaktivität.
 */
let inseln: readonly Island[] = [];

/** Inselumrisse der laufenden Karte, für Anzeigen außerhalb der Pixi-Welt. */
export function currentIslands(): readonly Island[] {
  return inseln;
}

/**
 * Baut das Abstandsfeld der Karte. `null`, wenn die Karte offenes Wasser ist
 * (ocean01) — dann bleibt der Küstenblock im Shader stillgelegt.
 */
export function buildIslandField(map: GameMap): IslandField | null {
  inseln = map.islands ?? [];
  if (inseln.length === 0) return null;

  const beginn = performance.now();

  const breite = FELD_KANTE;
  const hoehe = Math.max(1, Math.round((FELD_KANTE * map.height) / map.width));
  /*
   * Metergröße einer Zelle. Sie gilt für BEIDE Achsen — die euklidische
   * Distanztransformation rechnet in Zellen und kann nicht zwischen einem
   * waagerechten und einem senkrechten Schritt unterscheiden. Für die eckigen
   * Seitenverhältnisse, die als Karte in Frage kommen, geht die Rundung oben
   * auf; ein krummes Verhältnis brächte einen Fehler weit unter einem Prozent
   * und damit weit unter einer Zellbreite.
   */
  const zelle = map.width / breite;

  const maske = rasterMaske(map, inseln, breite, hoehe);
  // Zwei Läufe: einmal mit dem LAND als Saat (ergibt den Abstand jedes
  // Wasserpunktes zur Küste), einmal mit dem WASSER als Saat (ergibt den
  // Abstand jedes Landpunktes zur Küste).
  const nachLand = distanzQuadrat(maske, breite, hoehe, 1);
  const nachWasser = distanzQuadrat(maske, breite, hoehe, 0);

  const daten = new Uint8Array(breite * hoehe * 4);
  for (let i = 0; i < breite * hoehe; i += 1) {
    const anLand = maske[i] === 1;
    const roh = Math.sqrt(anLand ? nachWasser[i] : nachLand[i]);
    /*
     * ⚠️ Eine halbe Zelle abziehen. Das Feld misst von Zellmitte zu Zellmitte:
     * eine Wasserzelle direkt an der Küste bekommt den Abstand 1, die Landzelle
     * gegenüber ebenfalls — die Wasserlinie liegt aber GENAU dazwischen. Ohne
     * den Abzug läge sie eine halbe Zelle (7 m) daneben, und zwar auf beiden
     * Seiten in dieselbe Richtung: die Insel wüchse sichtbar über ihren Umriss
     * hinaus.
     */
    const meter = Math.max(roh - 0.5, 0) * zelle * (anLand ? -1 : 1);
    const anteil = Math.min(Math.max((meter + REICHWEITE) / (2 * REICHWEITE), 0), 1);
    const wert = Math.round(anteil * 65535);
    const p = i * 4;
    daten[p] = wert >>> 8;
    daten[p + 1] = wert & 255;
    daten[p + 2] = 0;
    // Deckend. Nicht kosmetisch: eine Alpha unter 1 ließe eine Vormultiplikation
    // irgendwo in der Kette die beiden Datenkanäle auffressen.
    daten[p + 3] = 255;
  }

  const texture = new Texture({
    source: new BufferImageSource({
      resource: daten,
      width: breite,
      height: hoehe,
      format: 'rgba8unorm',
      alphaMode: 'no-premultiply-alpha',
      /*
       * ⚠️ PUNKTGENAU abtasten, und keine Mipmaps. Der Wert steckt in zwei
       * Bytes; ein bilinearer Sampler würde hohes und niedriges Byte GETRENNT
       * mitteln, und dort, wo das niedrige von 255 auf 0 überspringt, käme ein
       * Sprung über den halben Wertebereich heraus — als Sprenkelring entlang
       * jeder Küste. Der Shader mischt die vier Nachbarn selbst, NACH dem
       * Dekodieren.
       */
      scaleMode: 'nearest',
      autoGenerateMipmaps: false,
      // Endlos-Karte: eine Kartenlänge weiter liegt dieselbe Küste. Damit
      // stimmt das Feld auch für Weltkoordinaten jenseits der Naht.
      addressMode: 'repeat',
      label: 'island-field',
    }),
  });

  console.log(
    `[client] Küsten-Abstandsfeld ${breite}×${hoehe} (${zelle.toFixed(1)} m/Zelle) für ` +
      `${inseln.length} ${inseln.length === 1 ? 'Insel' : 'Inseln'} ` +
      `in ${Math.round(performance.now() - beginn)} ms gebaut`,
  );

  return { texture, breite, hoehe, reichweite: REICHWEITE };
}

/**
 * Rastert die Umrisse zu einer Land/Wasser-Maske.
 *
 * Über Canvas2D und nicht über Punkt-in-Polygon je Zelle: das wären 4,2
 * Millionen Punktproben gegen zusammen rund 470 Kanten, also Milliarden von
 * Kantenprüfungen. Der Rasterizer des Browsers macht dieselbe Arbeit in
 * Millisekunden, und die Kantenglättung fällt beim Schwellwert ohnehin weg.
 */
function rasterMaske(
  map: GameMap,
  liste: readonly Island[],
  breite: number,
  hoehe: number,
): Uint8Array {
  const maske = new Uint8Array(breite * hoehe);

  const canvas = document.createElement('canvas');
  canvas.width = breite;
  canvas.height = hoehe;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    console.warn('[client] Kein 2D-Kontext für das Küstenfeld — die Karte bleibt offenes Wasser');
    return maske;
  }

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, breite, hoehe);
  ctx.fillStyle = '#fff';

  const sx = breite / map.width;
  const sy = hoehe / map.height;
  for (const insel of liste) {
    const umriss = insel.polygon;
    if (umriss.length < 3) continue;
    ctx.beginPath();
    // Der Umriss ist NICHT geschlossen (siehe `Island`) — `closePath` zieht die
    // letzte Kante vom letzten zum ersten Punkt.
    ctx.moveTo(umriss[0]!.x * sx, umriss[0]!.y * sy);
    for (let i = 1; i < umriss.length; i += 1) {
      ctx.lineTo(umriss[i]!.x * sx, umriss[i]!.y * sy);
    }
    ctx.closePath();
    ctx.fill();
  }

  const bild = ctx.getImageData(0, 0, breite, hoehe).data;
  for (let i = 0; i < maske.length; i += 1) {
    // Halbe Deckung zählt als Land: der Schwellwert legt die Kante dorthin, wo
    // der Rasterizer sie mit seiner Glättung ohnehin hingerechnet hat.
    maske[i] = bild[i * 4]! >= 128 ? 1 : 0;
  }
  return maske;
}

/**
 * Quadrierter euklidischer Abstand jeder Zelle zur nächsten SAAT-Zelle, in
 * Zellen².
 *
 * Verfahren nach Felzenszwalb/Huttenlocher: die zweidimensionale Transformation
 * zerfällt in zwei unabhängige eindimensionale — erst über alle Zeilen, dann
 * über alle Spalten. Kosten linear in der Zellenzahl.
 *
 * ⚠️ Die naheliegende Alternative — je Zelle den Abstand zu allen Polygonkanten
 * suchen — wäre 4,2 Mio. Zellen × 470 Kanten und damit Minuten statt
 * Millisekunden.
 *
 * ⚠️ Die Transformation rechnet in der EBENE, nicht auf dem Torus: sie sieht
 * kein Land jenseits der Naht. Getragen wird das allein vom Wasserrand — bei
 * ocean04 sind es 4,9 km, und weil `REICHWEITE` ohnehin bei 1,5 km kappt, steht
 * beiderseits der Naht derselbe gekappte Wert. Wer eine Insel näher als
 * `REICHWEITE` an eine Kante schiebt, bekommt dort einen abgeschnittenen
 * Flachwassersaum — die Textur wiederholt sich zwar (addressMode), aber die
 * Zahlen darin sind dann schon falsch berechnet. `defineMap` prüft nur, dass
 * eine Insel die Naht nicht ÜBERQUERT, nicht ihren Abstand dazu.
 */
function distanzQuadrat(
  maske: Uint8Array,
  breite: number,
  hoehe: number,
  saat: number,
): Float32Array {
  const feld = new Float32Array(breite * hoehe);
  for (let i = 0; i < feld.length; i += 1) feld[i] = maske[i] === saat ? 0 : UNENDLICH;

  const laenge = Math.max(breite, hoehe);
  const quelle = new Float64Array(laenge);
  const ziel = new Float64Array(laenge);
  const scheitel = new Int32Array(laenge);
  const grenze = new Float64Array(laenge + 1);

  for (let y = 0; y < hoehe; y += 1) {
    const zeile = y * breite;
    for (let x = 0; x < breite; x += 1) quelle[x] = feld[zeile + x]!;
    einDimension(quelle, ziel, scheitel, grenze, breite);
    for (let x = 0; x < breite; x += 1) feld[zeile + x] = ziel[x]!;
  }

  for (let x = 0; x < breite; x += 1) {
    for (let y = 0; y < hoehe; y += 1) quelle[y] = feld[y * breite + x]!;
    einDimension(quelle, ziel, scheitel, grenze, hoehe);
    for (let y = 0; y < hoehe; y += 1) feld[y * breite + x] = ziel[y]!;
  }

  return feld;
}

/**
 * Untere Hüllkurve der Parabeln `(q - i)² + quelle[i]` — der eindimensionale
 * Kern des Verfahrens. `scheitel` und `grenze` sind Arbeitsspeicher des
 * Aufrufers; sie werden hier vollständig neu beschrieben.
 *
 * ⚠️ `UNENDLICH` ist bewusst 1e20 und nicht `Infinity`: die Schnittstelle
 * zweier Parabeln wird als Differenz zweier solcher Werte berechnet, und
 * `Infinity - Infinity` wäre NaN — der Vergleich in der Schleife liefe dann ins
 * Leere und die Hüllkurve käme mit Müll heraus. 1e20 ist groß genug, um jeden
 * echten Abstand zu schlagen, und klein genug, dass die Differenz noch stimmt.
 */
function einDimension(
  quelle: Float64Array,
  ziel: Float64Array,
  scheitel: Int32Array,
  grenze: Float64Array,
  n: number,
): void {
  let k = 0;
  scheitel[0] = 0;
  grenze[0] = -UNENDLICH;
  grenze[1] = UNENDLICH;

  for (let q = 1; q < n; q += 1) {
    let v = scheitel[k]!;
    let schnitt = (quelle[q]! + q * q - (quelle[v]! + v * v)) / (2 * q - 2 * v);
    while (schnitt <= grenze[k]!) {
      k -= 1;
      v = scheitel[k]!;
      schnitt = (quelle[q]! + q * q - (quelle[v]! + v * v)) / (2 * q - 2 * v);
    }
    k += 1;
    scheitel[k] = q;
    grenze[k] = schnitt;
    grenze[k + 1] = UNENDLICH;
  }

  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (grenze[k + 1]! < q) k += 1;
    const v = scheitel[k]!;
    ziel[q] = (q - v) * (q - v) + quelle[v]!;
  }
}

let gelaende: TerrainTextures | null = null;
let gelaendeLauf: Promise<TerrainTextures | null> | null = null;

/**
 * Holt Sand- und Graskachel. Sie hängen bewusst NICHT am allgemeinen
 * Ladevorgang: Karten ohne Landmassen (ocean01) sollen die knapp 300 kB gar
 * nicht erst anfassen, und wenn Land im Spiel ist, läuft der Abruf ohnehin im
 * Ladebildschirm neben dem Bau des Abstandsfelds.
 *
 * Ein Fehlschlag ist kein Abbruch — der Shader zeigt dann weißes Land. Das ist
 * hässlich, aber es steht wenigstens sichtbar da, wo eine Insel liegt.
 */
export function loadTerrainTextures(): Promise<TerrainTextures | null> {
  if (gelaende) return Promise.resolve(gelaende);
  gelaendeLauf ??= Promise.all([
    Assets.load<Texture>({ src: sandUrl, data: { autoGenerateMipmaps: true } }),
    Assets.load<Texture>({ src: grasUrl, data: { autoGenerateMipmaps: true } }),
  ])
    .then(([sand, gras]) => {
      // Beide werden über die ganze Insel WIEDERHOLT — ohne diesen Modus
      // klemmt Pixi die Koordinate an der Kachelkante fest, und außerhalb der
      // ersten Kachel stünde ein verschmierter Streifen.
      sand.source.style.addressMode = 'repeat';
      gras.source.style.addressMode = 'repeat';
      gelaende = { sand, gras };
      return gelaende;
    })
    .catch((fehler: unknown) => {
      console.warn('[client] Bodentexturen der Küste nicht ladbar:', fehler);
      return null;
    });
  return gelaendeLauf;
}
