import { Assets, Rectangle, Texture } from 'pixi.js';
import type { LoadStep } from './preload';

import explosionUrl from '../assets/fx/explosion_sheet.webp';
import foamUrl from '../assets/fx/foam_puff.webp';
import oceanWaterUrl from '../assets/fx/ocean_water.webp';
import smokeUrl from '../assets/fx/smoke_puff.webp';
import splashUrl from '../assets/fx/splash_sheet.webp';

/**
 * Effekt-Grafiken: Schaum, Rauch, Wasserfontäne, Explosion.
 *
 * Erzeugt von `tools/fx-build.py` (prozedurales fBm-Rauschen). Sie ersetzen die
 * früher mit `Graphics` gezeichneten Kreise und Striche — ein Kreis sieht nun
 * einmal nicht wie Schaum aus, egal wie man ihn einfärbt.
 *
 * Die beiden Sätze liegen als 5×5-Raster à 128 px in einem Bild und werden hier
 * in Einzelbilder zerlegt.
 */
const KACHEL = 128;
const SPALTEN = 5;
const BILDER = 25;

let foam: Texture | null = null;
let smoke: Texture | null = null;
let oceanWater: Texture | null = null;
let splash: Texture[] = [];
let explosion: Texture[] = [];

/**
 * ⚠️ Für die Sätze KEINE Mipmaps: die Kacheln liegen randlos nebeneinander, und
 * eine Mip-Stufe mittelt über die Kachelgrenze hinweg — beim Rauszoomen blutete
 * das Nachbarbild sichtbar in den Rand. Die Einzelgrafiken haben einen
 * transparenten Rahmen und dürfen Mipmaps behalten.
 */
async function zerlegen(url: string): Promise<Texture[]> {
  const blatt = await Assets.load<Texture>({ src: url, data: { autoGenerateMipmaps: false } });
  const frames: Texture[] = [];
  for (let i = 0; i < BILDER; i += 1) {
    const spalte = i % SPALTEN;
    const zeile = Math.floor(i / SPALTEN);
    frames.push(
      new Texture({
        source: blatt.source,
        frame: new Rectangle(spalte * KACHEL, zeile * KACHEL, KACHEL, KACHEL),
      }),
    );
  }
  return frames;
}

/** Wie viele Effekt-Grafiken geladen werden — für die Fortschrittsrechnung. */
export function fxTextureCount(): number {
  return 5;
}

export async function loadFxTextures(onStep?: LoadStep): Promise<void> {
  const gesamt = fxTextureCount();
  if (foam) {
    onStep?.(gesamt, gesamt);
    return;
  }

  let geladen = 0;
  const melden = <T,>(versprechen: Promise<T>): Promise<T> =>
    versprechen.then((wert) => {
      geladen += 1;
      onStep?.(geladen, gesamt);
      return wert;
    });

  const [f, s, ozean, sp, ex] = await Promise.all([
    melden(Assets.load<Texture>({ src: foamUrl, data: { autoGenerateMipmaps: true } })),
    melden(Assets.load<Texture>({ src: smokeUrl, data: { autoGenerateMipmaps: true } })),
    melden(Assets.load<Texture>({ src: oceanWaterUrl, data: { autoGenerateMipmaps: true } })),
    melden(zerlegen(splashUrl)),
    melden(zerlegen(explosionUrl)),
  ]);
  // Die Ozean-Kachel wird über die ganze Karte WIEDERHOLT — ohne diesen Modus
  // klemmt Pixi die Koordinate am Rand fest und die Fläche wäre außerhalb der
  // ersten Kachel ein einziger verschmierter Streifen.
  ozean.source.style.addressMode = 'repeat';
  foam = f;
  smoke = s;
  oceanWater = ozean;
  splash = sp;
  explosion = ex;
}

/**
 * Die Wasseroberfläche als kachelnde FARBAUFNAHME — erzeugt von
 * `tools/ocean-texture.py`. Der Ozean-Shader zeigt sie an und verzerrt sie;
 * Wellen, Kämme und Schaum stecken bereits im Bild.
 */
export function oceanWaterTexture(): Texture | null {
  return oceanWater;
}

/** Schaumbatzen für Kielwasser und Gischt. Null, solange nicht geladen. */
export function foamTexture(): Texture | null {
  return foam;
}

/** Rauchballen für Schadensrauch. Weiß — zur Laufzeit über `tint` gefärbt. */
export function smokeTexture(): Texture | null {
  return smoke;
}

/** Einzelbild der Wasserfontäne zum Fortschritt 0..1. */
export function splashFrame(progress: number): Texture | null {
  return frameAt(splash, progress);
}

/** Einzelbild der Explosion zum Fortschritt 0..1. */
export function explosionFrame(progress: number): Texture | null {
  return frameAt(explosion, progress);
}

function frameAt(frames: Texture[], progress: number): Texture | null {
  if (frames.length === 0) return null;
  const index = Math.min(Math.floor(progress * frames.length), frames.length - 1);
  return frames[Math.max(index, 0)] ?? null;
}
