/**
 * Vorladen der ANZEIGE-Grafiken.
 *
 * Die Spielgrafiken holt Pixi über `Assets`; die Rahmen und Symbole des HUD
 * dagegen lädt der Browser erst, wenn eine CSS-Regel sie zum ersten Mal
 * braucht — also mitten im Beitritt. Genau das sah man: das Gefecht lief schon,
 * während Rumpfleiste, Sonarrahmen und Waffensymbole nacheinander eintrudelten.
 *
 * Hier werden sie vorher geholt und DEKODIERT (`decode()`): ein bloßes `src`
 * setzen bringt das Bild in den Cache, die Umwandlung in Pixel passiert aber
 * erst beim ersten Zeichnen — bei 600 kB PNG ein sichtbarer Ruck.
 */

/** Fortschrittsmeldung: wie viele Einzelstücke von wie vielen fertig sind. */
export type LoadStep = (fertig: number, gesamt: number) => void;

/*
 * Per Glob statt Handliste: wer eine Grafik hinzufügt, muss nicht daran denken,
 * sie hier einzutragen. Die Ausnahmen unten sind die Bildschirme, die im
 * GEFECHT nicht vorkommen — sie kosten zusammen über ein Megabyte und würden
 * den Ladebalken für nichts verlängern.
 */
const QUELLEN = import.meta.glob('../assets/{ui,icons}/*.{png,webp}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/**
 * Nicht fürs Gefecht: die Menü-Hintergründe lädt der jeweilige Bildschirm
 * selbst, und das Ladebild zeigt der Ladeschirm gerade JETZT — es hier
 * mitzuzählen hieße, den Balken auf sein eigenes Hintergrundbild warten zu
 * lassen.
 */
const NUR_MENUE = ['login-bg', 'menu-bg', 'loading-bg'];

const BILDER = Object.entries(QUELLEN)
  .filter(([pfad]) => !NUR_MENUE.some((name) => pfad.includes(name)))
  .map(([, url]) => url);

let fertig = false;

/**
 * Holt alle HUD-Grafiken parallel. Ein Fehlschlag einzelner Bilder bricht NICHT
 * ab: ein fehlendes Symbol ist ein Schönheitsfehler, ein hängender Ladebildschirm
 * wäre der eigentliche Schaden.
 */
export async function preloadUiImages(onStep?: LoadStep): Promise<void> {
  const gesamt = BILDER.length;
  if (fertig) {
    onStep?.(gesamt, gesamt);
    return;
  }

  let geladen = 0;
  await Promise.all(
    BILDER.map(async (url) => {
      try {
        const bild = new Image();
        bild.src = url;
        await bild.decode();
      } catch {
        // Abgebrochen oder Format unbekannt — der Browser lädt es später eben
        // beim ersten Zeichnen nach.
      }
      geladen += 1;
      onStep?.(geladen, gesamt);
    }),
  );
  fertig = true;
}

/** Anzahl der vorzuladenden Anzeige-Grafiken — für die Gesamtrechnung. */
export function uiImageCount(): number {
  return BILDER.length;
}
