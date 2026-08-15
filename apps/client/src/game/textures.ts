import { DEFAULT_SHIP_SIZES, DEFAULT_VESSEL_MODEL, HULL_DIMENSIONS } from '@subwarfare/shared';
import { Assets, Spritesheet, Texture, type SpritesheetData } from 'pixi.js';
import type { LoadStep } from './preload';

import destroyerData from '../assets/vessels/destroyer01/atlas.json';
import destroyerUrl from '../assets/vessels/destroyer01/atlas.webp';
import destroyer2Data from '../assets/vessels/destroyer02/atlas.json';
import destroyer2Url from '../assets/vessels/destroyer02/atlas.webp';
import destroyer3Data from '../assets/vessels/destroyer03/atlas.json';
import destroyer3Url from '../assets/vessels/destroyer03/atlas.webp';
import fregatteData from '../assets/vessels/fregatte01/atlas.json';
import fregatteUrl from '../assets/vessels/fregatte01/atlas.webp';
import fregatte2Data from '../assets/vessels/fregatte02/atlas.json';
import fregatte2Url from '../assets/vessels/fregatte02/atlas.webp';
import periscopeData from '../assets/vessels/periscope/atlas.json';
import periscopeUrl from '../assets/vessels/periscope/atlas.webp';
import speedsterData from '../assets/vessels/speedster01/atlas.json';
import speedsterUrl from '../assets/vessels/speedster01/atlas.webp';
import submarineData from '../assets/vessels/submarine01/atlas.json';
import submarineUrl from '../assets/vessels/submarine01/atlas.webp';
import submarine2Data from '../assets/vessels/submarine02/atlas.json';
import submarine2Url from '../assets/vessels/submarine02/atlas.webp';
import submarine3Data from '../assets/vessels/submarine03/atlas.json';
import submarine3Url from '../assets/vessels/submarine03/atlas.webp';
import submarine4Data from '../assets/vessels/submarine04/atlas.json';
import submarine4Url from '../assets/vessels/submarine04/atlas.webp';
import tankerData from '../assets/vessels/tanker01/atlas.json';
import tankerUrl from '../assets/vessels/tanker01/atlas.webp';
import shellData from '../assets/vessels/he_round01/atlas.json';
import shellUrl from '../assets/vessels/he_round01/atlas.webp';
import torpedoData from '../assets/vessels/torpedo01/atlas.json';
import torpedoUrl from '../assets/vessels/torpedo01/atlas.webp';
import waterbombData from '../assets/vessels/waterbomb01/atlas.json';
import waterbombUrl from '../assets/vessels/waterbomb01/atlas.webp';
import decoyData from '../assets/vessels/torpedo02/atlas.json';
import decoyUrl from '../assets/vessels/torpedo02/atlas.webp';
import lootData from '../assets/vessels/loot01/atlas.json';
import lootUrl from '../assets/vessels/loot01/atlas.webp';
import buoyData from '../assets/vessels/buoy01/atlas.json';
import buoyUrl from '../assets/vessels/buoy01/atlas.webp';
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
  tanker01: {
    data: tankerData as unknown as SpritesheetData,
    url: tankerUrl,
    lengthMetres: HULL_DIMENSIONS.tanker01.length,
    sideProfilePx: 373,
  },
  fregatte02: {
    data: fregatte2Data as unknown as SpritesheetData,
    url: fregatte2Url,
    lengthMetres: HULL_DIMENSIONS.fregatte02.length,
    sideProfilePx: 736,
  },
  submarine02: {
    data: submarine2Data as unknown as SpritesheetData,
    url: submarine2Url,
    lengthMetres: HULL_DIMENSIONS.submarine02.length,
    sideProfilePx: 780,
  },
  destroyer01: {
    data: destroyerData as unknown as SpritesheetData,
    url: destroyerUrl,
    lengthMetres: HULL_DIMENSIONS.destroyer01.length,
    sideProfilePx: 789,
  },
  destroyer02: {
    data: destroyer2Data as unknown as SpritesheetData,
    url: destroyer2Url,
    lengthMetres: HULL_DIMENSIONS.destroyer02.length,
    sideProfilePx: 754,
  },
  // destroyer03 fährt den Atlas, der bis Protokoll 19 fälschlich fregatte02
  // war — daher auch dessen Seitenprofil (748 px).
  destroyer03: {
    data: destroyer3Data as unknown as SpritesheetData,
    url: destroyer3Url,
    lengthMetres: HULL_DIMENSIONS.destroyer03.length,
    sideProfilePx: 748,
  },
  submarine03: {
    data: submarine3Data as unknown as SpritesheetData,
    url: submarine3Url,
    lengthMetres: HULL_DIMENSIONS.submarine03.length,
    sideProfilePx: 772,
  },
  submarine04: {
    data: submarine4Data as unknown as SpritesheetData,
    url: submarine4Url,
    lengthMetres: HULL_DIMENSIONS.submarine04.length,
    sideProfilePx: 804,
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
  // Wasserbombe: das Fass ist real ~1,5 m — wie bei den anderen Projektilen
  // auf Spielsichtbarkeit gezogen.
  waterbomb01: {
    data: waterbombData as unknown as SpritesheetData,
    url: waterbombUrl,
    lengthMetres: 6,
    sideProfilePx: 534,
  },
  // Geschützgranate: real ~0,5 m — gameplay-sichtbar auf 4 m gezogen.
  he_round01: {
    data: shellData as unknown as SpritesheetData,
    url: shellUrl,
    lengthMetres: 4,
    sideProfilePx: 369,
  },
  // Requisiten: 8 Views statt 64 (drehen sich nicht), Größen auf
  // Spielsichtbarkeit gezogen — eine reale 1-m-Kiste wäre unsichtbar.
  loot01: {
    data: lootData as unknown as SpritesheetData,
    url: lootUrl,
    lengthMetres: 22,
    sideProfilePx: 257,
  },
  buoy01: {
    data: buoyData as unknown as SpritesheetData,
    url: buoyUrl,
    lengthMetres: 18,
    sideProfilePx: 206,
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
 * Größenfaktoren je Modell (ships.size × Klassen-Basis, siehe scaledHull in
 * shared). Start = Code-Defaults; `setModelSizes` übernimmt beim `welcome`
 * die Katalogwerte des Servers — mit DENSELBEN Faktoren kollidiert er.
 * Projektile/Requisiten stehen nicht in der Map und fahren Faktor 1.
 */
const sizeFactors = new Map<string, number>(
  Object.entries(DEFAULT_SHIP_SIZES).filter(
    (eintrag): eintrag is [string, number] => typeof eintrag[1] === 'number',
  ),
);

/** Übernimmt die Größenfaktoren aus dem Server-Katalog (welcome.ships). */
export function setModelSizes(
  ships: ReadonlyArray<{ model: string; size?: number }>,
): void {
  for (const ship of ships) {
    if (typeof ship.size === 'number' && ship.size > 0) sizeFactors.set(ship.model, ship.size);
  }
}

function sizeFactor(model: string): number {
  return sizeFactors.get(model) ?? 1;
}

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
export async function loadVesselTextures(onStep?: LoadStep): Promise<void> {
  const gesamt = vesselAtlasCount();
  if (loaded.size > 0) {
    onStep?.(gesamt, gesamt);
    return;
  }

  let geladen = 0;
  const melden = (): void => {
    geladen += 1;
    onStep?.(geladen, gesamt);
  };

  /*
   * Alle Atlanten NEBENLÄUFIG. Vorher lief die Schleife streng nacheinander:
   * bei vierzehn Bildern und ~6 MB wartete der Beitritt damit auf die Summe
   * aller Rundreisen statt auf die längste. Die Reihenfolge spielt keine Rolle —
   * `loaded` ist nach Modell verschlüsselt, nicht nach Position.
   */
  await Promise.all(
    Object.entries(DEFINITIONS).map(async ([model, def]) => {
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
      for (let i = 0; i < count; i += 1) {
        const name = `dir-${String(i).padStart(2, '0')}`;
        const texture = sheet.textures[name];
        const anchor = def.data.frames[name]?.anchor;
        if (!texture || !anchor) {
          console.warn(`[client] Frame fehlt im Atlas ${model}: ${name} — Vektor-Fallback.`);
          melden();
          return;
        }
        directions.push({ texture, angleDegrees: i * degreesPerFrame, anchor });
      }

      loaded.set(model, {
        directions,
        degreesPerFrame,
        metresPerPx: def.lengthMetres / def.sideProfilePx,
      });
      melden();
    }),
  );

  periscopeModel = await loadExtra(
    periscopeUrl,
    periscopeData as unknown as SpritesheetData,
    PERISCOPE_HEIGHT_METRES,
  );
  melden();
}

/** Wie viele Atlanten insgesamt geladen werden — Periskop eingerechnet. */
export function vesselAtlasCount(): number {
  return Object.keys(DEFINITIONS).length + 1;
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
  const usedModel = loaded.has(model) ? model : DEFAULT_VESSEL_MODEL;
  const entry = loaded.get(usedModel);
  if (!entry) return null;
  const index =
    Math.round((((courseDegrees % 360) + 360) % 360) / entry.degreesPerFrame) %
    entry.directions.length;
  const direction = entry.directions[index];
  return direction
    ? { ...direction, metresPerPx: entry.metresPerPx * sizeFactor(usedModel) }
    : null;
}

/** Die beiden Nachbar-Ansichten eines Kurses samt Mischanteil. */
export interface DirectionFramePair {
  /** Ansicht UNTER dem Kurs (voll deckend gezeichnet). */
  unter: DirectionFrame;
  /** Nächste Ansicht im Uhrzeigersinn (mit `anteil` darübergelegt). */
  ueber: DirectionFrame;
  /** Winkelposition zwischen beiden, 0..1 — die Deckkraft der oberen. */
  anteil: number;
}

/**
 * Beide Nachbar-Frames zum Kurs — für den KONTINUIERLICHEN Winkel-Blend der
 * Schiffe: statt beim Rasterwechsel umzuschalten (und den Perspektivsprung
 * mit einer Zeitblende zu kaschieren), liegen immer beide Nachbarn
 * übereinander, und `anteil` wandert stetig mit dem Kurs. An der Rastergrenze
 * ist die obere Ansicht exakt voll deckend und übernimmt als neue untere —
 * es gibt keinen Umschaltmoment mehr, den man sehen könnte.
 */
export function directionFramePair(
  model: string,
  courseDegrees: number,
): DirectionFramePair | null {
  const usedModel = loaded.has(model) ? model : DEFAULT_VESSEL_MODEL;
  const entry = loaded.get(usedModel);
  if (!entry) return null;
  const metresPerPx = entry.metresPerPx * sizeFactor(usedModel);
  const position = (((courseDegrees % 360) + 360) % 360) / entry.degreesPerFrame;
  const index = Math.floor(position) % entry.directions.length;
  const naechster = (index + 1) % entry.directions.length;
  const a = entry.directions[index];
  const b = entry.directions[naechster];
  if (!a || !b) return null;
  return {
    unter: { ...a, metresPerPx },
    ueber: { ...b, metresPerPx },
    anteil: position - Math.floor(position),
  };
}

export function hasVesselTextures(): boolean {
  return loaded.size > 0;
}
