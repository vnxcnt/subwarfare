import { Assets, Texture } from 'pixi.js';
import destroyerUrl from '../assets/vessels/destroyer-01.png';
import { HULL } from '../config';

let hullTexture: Texture | null = null;

/**
 * Lädt die Fahrzeuggrafiken. Muss vor dem ersten `spawn` durchgelaufen sein —
 * `VesselView` greift synchron darauf zu und fällt sonst auf das
 * Vektorpolygon zurück.
 */
export async function loadVesselTextures(): Promise<void> {
  if (hullTexture) return;

  const texture = await Assets.load<Texture>({
    src: destroyerUrl,
    data: {
      // In Pixi 8 per Default AUS. Ohne Mipmaps flimmert der Rumpf bei
      // Übersichtszoom sichtbar — dort wird eine 1364-px-Textur auf rund
      // 15 px gezeichnet.
      autoGenerateMipmaps: true,
    },
  });

  // Die Projektion staucht die Textur ANISOTROP (y auf `tilt`, x unverändert) —
  // genau der Fall, für den anisotrope Filterung gemacht ist. Nötig ist
  // ceil(1/tilt); bei 0,42 also 3, mit Reserve 4.
  texture.source.maxAnisotropy = 4;

  hullTexture = texture;
}

export function getHullTexture(): Texture | null {
  return hullTexture;
}

/** Weltmaße des Sprites inklusive des transparenten Randes der Grafik. */
export function hullSpriteSize(texture: Texture): { width: number; height: number } {
  return {
    width: texture.width / HULL.texturePxPerMetre,
    height: texture.height / HULL.texturePxPerMetre,
  };
}
