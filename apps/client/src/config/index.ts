import type { GameMap, VesselProfile } from '@subwarfare/shared';
import decoyIcon from '../assets/icons/decoy.png';
import gunIcon from '../assets/icons/gun.png';
import torpedoIcon from '../assets/icons/torpedo.png';
import waterbombIcon from '../assets/icons/waterbomb.png';

/** WebSocket-Endpunkt des Game-Servers. Über `VITE_GAME_SERVER_URL` überschreibbar. */
export const GAME_SERVER_URL = import.meta.env.VITE_GAME_SERVER_URL ?? 'ws://localhost:8080';

/** Startwerte für den PixiJS-Renderer. */
export const RENDERER = {
  /** Tiefes Ozeanblau — sichtbar nur außerhalb der Kartengrenzen. */
  backgroundColor: 0x04141f,
  antialias: true,
  /** WebGL statt WebGPU — breitere Browser-Abdeckung. */
  preference: 'webgl',
  /**
   * Obergrenze für die Renderauflösung. Der Wasser-Shader ist rein
   * füllratengebunden; bei devicePixelRatio 2 vervierfachen sich die
   * Fragmentkosten für kaum sichtbaren Gewinn.
   */
  maxResolution: 1.5,
} as const;

/**
 * Darstellung der Welt. Die Welt selbst bleibt kartesisch — das hier ist
 * ausschließlich Client-Optik. Siehe `game/Projection.ts`.
 */
export const VIEW = {
  /**
   * Vertikale Stauchung — geometrisch `sin(Höhenwinkel der Kamera)`.
   * 1.0 = senkrecht von oben, 0.55 = 33,4°, 0.42 = 24,8° über dem Horizont.
   *
   * Je kleiner, desto flacher der Blick und desto stärker die Höhenwirkung.
   * Bei 12 m Rumpfbreite wird ein Turm ab tilt ≈ 0,45 sichtbar über dem Rumpf
   * stehen (Schwelle: `h > beam · tilt / sqrt(1 - tilt²)`).
   *
   * Zur Laufzeit über `setTilt()` verstellbar, im Dev-Build mit den Tasten
   * [ und ]. Dieser Wert ist nur der Startwert.
   */
  tilt: 0.42,
  /**
   * Untergrenze. Darunter kippt der Eindruck: ohne Perspektive schrumpfen
   * entfernte Dinge nicht, und ein Rumpf querab wird zum Strich (bei 0,25 noch
   * 3 px hoch). Zusätzlich wächst die anisotrope Texturstauchung auf 1/tilt.
   */
  minTilt: 0.25,
  /** Tief genug, dass die ganze 10.000er-Karte auch in kleinen Fenstern passt. */
  minZoom: 0.03,
  maxZoom: 4,
  /** Multiplikator pro Mausrad-Raste. */
  zoomStep: 1.15,
  /** Anteil des Viewports, den die Karte beim Start ausfüllt. */
  fitMargin: 0.88,
} as const;

/** Aussehen der Wasserfläche. Farben als lineare RGB-Tripel für den Shader. */
export const WATER = {
  deep: [0.02, 0.09, 0.16],
  shallow: [0.06, 0.26, 0.34],
  /**
   * Richtung zur Sonne, als Weltvektor (x = Ost, y = Süd, z = oben).
   * Speist sowohl das Streiflicht im Wasser-Shader als auch die Schattenrichtung
   * der Fahrzeuge — beide MÜSSEN dieselbe Quelle benutzen, sonst fällt der
   * Schatten sichtbar in die falsche Richtung.
   */
  sun: [0.55, -0.83, 0.75],
  /**
   * Seegang von 0 (spiegelglatt) bis 1 (grob). Skaliert alle Windwellen;
   * die Dünung bleibt davon unberührt. Später vom Server steuerbar.
   */
  seaState: 0.7,
} as const;

/** Simulationstakt. Passt zum `tickRate`-Default 20 des Game-Servers. */
export const SIM = {
  fixedDt: 0.05,
  /** Deckelt das Aufholen nach einem Tab-Wechsel auf 0,25 s pro Frame. */
  maxCatchupSteps: 5,
} as const;

/**
 * Fahrleistung des Demoboots.
 *
 * ⚠️ `maxForward` ist eine DESIGN-Entscheidung, keine technische: ein echtes
 * U-Boot fährt rund 17 m/s (33 kn), damit dauert eine Kartenkante 9,8 Minuten.
 * 30 m/s (58 kn) ist Faktor 1,8 darüber — Kartenkante 5,6 min, eine typische
 * Gefechtsdistanz von 1–3 km in 30–100 s. Ändern kostet genau diese Zeile;
 * der Wendekreis bleibt konstant, die Bahnform also identisch.
 *
 * Die Werte bleiben vorerst hier und nicht in `@subwarfare/shared`: Tuning
 * läuft dadurch über Vite-HMR statt über einen tsc-Rebuild des Shared-Pakets.
 * Sobald der Server autoritativ rechnet, ziehen sie dorthin um.
 */
export const VESSEL_DEMO: VesselProfile = {
  maxForward: 30,
  maxReverse: -8,
  accel: 1.0,
  brake: 2.0,
  drag: 0.45,
  turnRadius: 220,
  thrusterRate: 3,
  maxTurnRate: 8,
  rudderAuthority: 25,
  arriveRadius: 25,
};

/** Startzustand des Demoboots — zeichengenau der Spawnpunkt `spawn-north`. */
export const DEMO_VESSEL = {
  id: 'demo',
  name: 'Testboot',
  x: 5_000,
  y: 1_000,
  rotation: 180,
} as const;

/**
 * Fremde Fahrzeuge, damit das Sonar etwas anzeigt und man Bewegung beurteilen
 * kann. Sind echte `Vessel` mit derselben Physik — kein KI-System, keine zweite
 * Datenquelle. Später ohne Änderung am Sonar durch `StateMessage.players` vom
 * Server ersetzbar.
 *
 * `patrol: false` lässt ein Boot liegen — daran sieht man sofort, ob Peilung
 * und Kursstrich im Sonar stimmen.
 */
export const DEMO_TRAFFIC = [
  { id: 'traffic-1', name: 'Kontakt Alpha', x: 6_400, y: 1_900, rotation: 250, patrol: true },
  { id: 'traffic-2', name: 'Kontakt Bravo', x: 3_600, y: 2_600, rotation: 40, patrol: true },
  { id: 'traffic-3', name: 'Kontakt Charlie', x: 5_200, y: 4_300, rotation: 315, patrol: true },
  { id: 'traffic-4', name: 'Kontakt Delta', x: 7_100, y: 3_400, rotation: 180, patrol: true },
  { id: 'traffic-5', name: 'Kontakt Echo', x: 4_100, y: 800, rotation: 90, patrol: false },
] as const;

/** Zufallsziele der Patrouillenboote halten diesen Abstand zum Kartenrand. */
export const PATROL_MARGIN = 600;

/**
 * Sonar-Rundsichtgerät (PPI).
 *
 * Der Strahl streicht im Uhrzeigersinn um und malt die Echos beim Überstreichen
 * frisch auf. Dazwischen steht das Bild still: ein Kontakt zeigt die Position
 * seines letzten Überstreichens, nicht seine aktuelle. Ein schnelles Ziel kann
 * dadurch bis zu eine Umlaufdauer veraltet sein.
 */
export const SONAR = {
  /** Erfassungsreichweite in Metern. */
  range: 4_000,
  /** Abstand der Entfernungsringe in Metern. */
  ringSpacing: 1_000,
  /** Sekunden je Umlauf. Bei 30 m/s legt ein Ziel dabei bis zu 240 m zurück. */
  sweepSeconds: 8,
  /** Nachleuchten des Strahls in Grad hinter der Spitze. */
  trailDegrees: 75,
  /** Dauer des roten Aufblitzens beim Überstreichen, in Sekunden. */
  flashSeconds: 0.35,
  /** Restsichtbarkeit eines Echos kurz vor dem nächsten Überstreichen. */
  minEchoAlpha: 0.14,
  /** Ringe, Kardinalkreuz, Strahl und Kurskerbe. */
  color: '#53b941',
  /** Die Scheibe selbst. */
  scopeBackground: '#031100',
  /** Fläche zwischen Scheibe und Rahmen. */
  frameBackground: '#141310',
  echoColor: '#e2b45a',
  flashColor: '#ff4a4a',
} as const;

/**
 * Munitionsslots. Vorerst reine Anzeige — es gibt kein Waffensystem.
 *
 * `icon: null` fällt auf das Kürzel zurück, damit ein Slot ohne Grafik nicht
 * leer dasteht. Sobald es Schiffstypen gibt, zieht diese Liste dorthin um: die
 * Anzahl der Slots hängt am Typ, nicht am Client.
 */
export const AMMO_SLOTS = [
  { id: 'slot-1', label: 'Torpedo', short: 'TRP', count: 12, icon: torpedoIcon },
  { id: 'slot-2', label: 'Wasserbombe', short: 'WBO', count: 24, icon: waterbombIcon },
  { id: 'slot-3', label: 'Täuschkörper', short: 'TKR', count: 6, icon: decoyIcon },
  { id: 'slot-4', label: 'Geschütz', short: 'GES', count: 4, icon: gunIcon },
] as const;

/**
 * Rumpfmaße in Weltunits. Bug zeigt lokal nach -y.
 *
 * Aktuell ein Zerstörer, abgeleitet aus dem Seitenverhältnis der Grafik
 * (240 × 1348 px ≙ 5,62 : 1). `length` ist die frei gewählte Bezugsgröße —
 * ändert man sie, skaliert das Schiff mit, weil die Breite aus der Grafik folgt.
 */
export const HULL = {
  length: 140,
  beam: 25,
  /**
   * Auflösung der Rumpfgrafik in Pixel je Meter. Daraus wird die Sprite-Größe
   * inklusive des transparenten Randes berechnet — so muss der Rand nirgends
   * separat verrechnet werden.
   */
  texturePxPerMetre: 9.629,
  /** Deutlich dunkler als das Wasser — sonst wirkt der Rumpf hohl. */
  fill: 0x081119,
  stroke: 0x6fd0bd,
  /** Mindestlänge auf dem Bildschirm; darunter wird gegenskaliert. */
  minScreenPx: 18,
  /** Obergrenze der Gegenskalierung. */
  maxBoost: 3,
  markerRadius: 30,
  markerColor: 0x6fd0bd,

  /**
   * Höhe der angehobenen Aufbauten über der Wasserlinie in Metern.
   *
   * 0 = keine separate Höhenebene. Beim Zerstörer stecken die Aufbauten flach
   * in der Rumpfgrafik; sie anzuheben bräuchte eine EIGENE Grafik, sonst wären
   * sie doppelt zu sehen.
   */
  sailHeight: 0,
  shadowAlpha: 0.32,
} as const;

/** Kameranachführung. */
export const FOLLOW = {
  /** alpha = 1 - exp(-lambda * dt). Framerate-unabhängig, Zeitkonstante 125 ms. */
  lambda: 8,
  /** Restweg in Bildschirmpixeln, ab dem einfach gesetzt statt gedämpft wird. */
  snapScreenPx: 0.25,
} as const;

export const INPUT = {
  /** Maximale Mausbewegung in CSS-Pixeln, die noch als Klick zählt. */
  clickMaxPixels: 5,
  /** Ab dieser Pan-Distanz schaltet die Kameranachführung ab. */
  followBreakPixels: 5,
  /** Maustaste für Fahrbefehle: 2 = rechts. */
  orderButton: 2,
} as const;

/** m/s je Knoten. 1 sm = 1852 m. Nur für die HUD-Anzeige. */
export const KNOTS = 0.514444;

/**
 * Solange keine Verbindung zum Server steht, rendert der Client diese Karte.
 * Die Maße entsprechen `ocean01`; Spawn- und Exit-Punkte bleiben bewusst leer —
 * die kennt nur der autoritative Server und schickt sie in der WelcomeMessage.
 */
export const FALLBACK_MAP: GameMap = {
  id: 'ocean01',
  width: 10_000,
  height: 10_000,
  spawnPoints: [],
  exitPoints: [],
};
