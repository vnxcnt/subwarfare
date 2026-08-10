import { DEFAULT_VESSEL_MODEL, HULL_DIMENSIONS } from '@subwarfare/shared';
import { Assets, Spritesheet, Texture, type SpritesheetData } from 'pixi.js';

import fregatteData from '../assets/vessels/fregatte01/atlas.json';
import fregatteUrl from '../assets/vessels/fregatte01/atlas.webp';
import periscopeData from '../assets/vessels/periscope/atlas.json';
import periscopeUrl from '../assets/vessels/periscope/atlas.webp';
import speedsterData from '../assets/vessels/speedster01/atlas.json';
import speedsterUrl from '../assets/vessels/speedster01/atlas.webp';
import submarineData from '../assets/vessels/submarine01/atlas.json';
import submarineUrl from '../assets/vessels/submarine01/atlas.webp';
import torpedoData from '../assets/vessels/torpedo01/atlas.json';
import torpedoUrl from '../assets/vessels/torpedo01/atlas.webp';
import decoyData from '../assets/vessels/torpedo02/atlas.json';
import decoyUrl from '../assets/vessels/torpedo02/atlas.webp';
import yachtgunData from '../assets/vessels/yachtgun01/atlas.json';
import yachtgunUrl from '../assets/vessels/yachtgun01/atlas.webp';

/**
 * Richtungs-Atlanten aller Schiffsmodelle: je Modell EIN Bild mit 64 Frames
 * `dir-00..63` (Kursindex × 5,625°, 00 = Nord, im Uhrzeigersinn).
 *
 * Kurszuordnung aus dem Kamera-Azimut der Meshy-Renders
 * (`Kurs = (Azimut − 90°) mod 360`, an den Kardinal-Frames sichtgeprüft).
 * fregatte01 trägt Anker = Modell-Pivot aus den Metadaten; die drei ohne
 * Metadaten nutzen die BBox-Mitte (Anker 0,5).
 */
interface ModelDefinition {
  data: SpritesheetData;
  url: string;
  /**
   * Weltlänge des Rumpfs in Metern und die daraus folgende Auflösung
   * (Seitenprofil-Pixel ÷ Länge). Die Längen sind DARSTELLUNGSGRÖSSEN —
   * die Fahrphysik hängt weiter für alle am DESTROYER-Profil, bis es echte
   * Klassenwerte gibt.
   */
  lengthMetres: number;
  sideProfilePx: number;
}

/**
 * Schiffslängen kommen aus `HULL_DIMENSIONS` (shared) — denselben Zahlen, mit
 * denen der Server die Torpedokollision rechnet. Eine eigene Länge hier würde
 * früher oder später driften, und dann explodieren Torpedos neben dem Schiff.
 */
const DEFINITIONS: Record<string, ModelDefinition> = {
  fregatte01: {
    data: fregatteData as unknown as SpritesheetData,
    url: fregatteUrl,
    lengthMetres: HULL_DIMENSIONS.fregatte01.length,
    sideProfilePx: 385,
  },
  yachtgun01: {
    data: yachtgunData as unknown as SpritesheetData,
    url: yachtgunUrl,
    lengthMetres: HULL_DIMENSIONS.yachtgun01.length,
    sideProfilePx: 350,
  },
  submarine01: {
    data: submarineData as unknown as SpritesheetData,
    url: submarineUrl,
    lengthMetres: HULL_DIMENSIONS.submarine01.length,
    sideProfilePx: 378,
  },
  speedster01: {
    data: speedsterData as unknown as SpritesheetData,
    url: speedsterUrl,
    lengthMetres: HULL_DIMENSIONS.speedster01.length,
    sideProfilePx: 344,
  },
  // Projektile: gleiche Atlas-Pipeline, nur kein fahrbares Schiff. Länge ist
  // Spielsichtbarkeit (echte Torpedos wären auf Kartenzoom unsichtbar klein).
  torpedo01: {
    data: torpedoData as unknown as SpritesheetData,
    url: torpedoUrl,
    lengthMetres: 10,
    sideProfilePx: 371,
  },
  torpedo02: {
    data: decoyData as unknown as SpritesheetData,
    url: decoyUrl,
    lengthMetres: 10,
    sideProfilePx: 371,
  },
};

interface DirectionEntry {
  texture: Texture;
  /** Kurs, für den dieser Frame gerendert wurde, in Grad. */
  angleDegrees: number;
  /** Normalisierter Anker dieses Frames. */
  anchor: { x: number; y: number };
}

export interface DirectionFrame extends DirectionEntry {
  /** Weltgröße eines Texturpixels dieses Modells in Metern. */
  metresPerPx: number;
}

interface LoadedModel {
  directions: DirectionEntry[];
  degreesPerFrame: number;
  metresPerPx: number;
}

const loaded = new Map<string, LoadedModel>();

/**
 * Das Periskop ist KEIN Schiffsmodell, sondern ein Anbauteil mit eigenem
 * 64-Richtungs-Atlas (gleiche Pipeline). Maßstab über die Wunschhöhe:
 * spielbar sichtbar statt realistisch winzig.
 */
const PERISCOPE_HEIGHT_METRES = 14;
let periscopeModel: LoadedModel | null = null;

/**
 * Lädt die Fahrzeuggrafiken aller Modelle. Muss vor dem ersten `spawn`
 * durchgelaufen sein — `VesselView` greift synchron darauf zu und fällt sonst
 * auf das Vektorpolygon zurück.
 */
export async function loadVesselTextures(): Promise<void> {
  if (loaded.size > 0) return;

  for (const [model, def] of Object.entries(DEFINITIONS)) {
    const base = await Assets.load<Texture>({
      src: def.url,
      data: {
        // In Pixi 8 per Default AUS. Ohne Mipmaps flimmern die Frames bei
        // Übersichtszoom sichtbar.
        autoGenerateMipmaps: true,
      },
    });

    const sheet = new Spritesheet(base, def.data);
    await sheet.parse();

    const names = Object.keys(def.data.frames);
    const count = names.length;
    const degreesPerFrame = 360 / count;

    const directions: DirectionEntry[] = [];
    let complete = true;
    for (let i = 0; i < count; i += 1) {
      const name = `dir-${String(i).padStart(2, '0')}`;
      const texture = sheet.textures[name];
      const anchor = def.data.frames[name]?.anchor;
      if (!texture || !anchor) {
        console.warn(`[client] Frame fehlt im Atlas ${model}: ${name} — Vektor-Fallback.`);
        complete = false;
        break;
      }
      directions.push({ texture, angleDegrees: i * degreesPerFrame, anchor });
    }
    if (!complete) continue;

    loaded.set(model, {
      directions,
      degreesPerFrame,
      metresPerPx: def.lengthMetres / def.sideProfilePx,
    });
  }

  periscopeModel = await loadExtra(
    periscopeUrl,
    periscopeData as unknown as SpritesheetData,
    PERISCOPE_HEIGHT_METRES,
  );
}

/** Lädt einen Anbauteil-Atlas (z. B. Periskop) mit Höhen-Maßstab. */
async function loadExtra(
  url: string,
  data: SpritesheetData,
  heightMetres: number,
): Promise<LoadedModel | null> {
  const base = await Assets.load<Texture>({ src: url, data: { autoGenerateMipmaps: true } });
  const sheet = new Spritesheet(base, data);
  await sheet.parse();

  const count = Object.keys(data.frames).length;
  const degreesPerFrame = 360 / count;
  const directions: DirectionEntry[] = [];
  let frameHeight = 1;
  for (let i = 0; i < count; i += 1) {
    const name = `dir-${String(i).padStart(2, '0')}`;
    const texture = sheet.textures[name];
    const anchor = data.frames[name]?.anchor;
    if (!texture || !anchor) return null;
    directions.push({ texture, angleDegrees: i * degreesPerFrame, anchor });
    frameHeight = Math.max(frameHeight, texture.height);
  }
  return { directions, degreesPerFrame, metresPerPx: heightMetres / frameHeight };
}

/** Periskop-Frame zum Kurs. Null, solange nicht geladen. */
export function periscopeFrame(courseDegrees: number): DirectionFrame | null {
  const entry = periscopeModel;
  if (!entry) return null;
  const index =
    Math.round((((courseDegrees % 360) + 360) % 360) / entry.degreesPerFrame) %
    entry.directions.length;
  const direction = entry.directions[index];
  return direction ? { ...direction, metresPerPx: entry.metresPerPx } : null;
}

/**
 * Frame zum Kurs in Grad für ein Modell — samt Rasterkurs, Anker und Maßstab.
 * Null, solange die Grafiken nicht geladen sind; unbekannte Modelle fallen
 * auf das Standardmodell zurück, damit ein künftiger Server-Wert einen alten
 * Client nicht leert.
 */
export function directionFrame(model: string, courseDegrees: number): DirectionFrame | null {
  const entry = loaded.get(model) ?? loaded.get(DEFAULT_VESSEL_MODEL);
  if (!entry) return null;
  const index =
    Math.round((((courseDegrees % 360) + 360) % 360) / entry.degreesPerFrame) %
    entry.directions.length;
  const direction = entry.directions[index];
  return direction ? { ...direction, metresPerPx: entry.metresPerPx } : null;
}

export function hasVesselTextures(): boolean {
  return loaded.size > 0;
}
