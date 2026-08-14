import type { GameMap, VesselProfile } from '@subwarfare/shared';
import { DECOY, DESTROYER, GUN, TORPEDO } from '@subwarfare/shared';
import decoyIcon from '../assets/icons/decoy.png';
import gunIcon from '../assets/icons/gun.png';
import torpedoIcon from '../assets/icons/torpedo.png';
import waterbombIcon from '../assets/icons/waterbomb.png';

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
   * SENKRECHT VON OBEN, und das ist eine bewusste Entscheidung: jeder Wert
   * unter 1 staucht die Welt-y-Achse. Die quadratische 10.000er-Karte erschien
   * dadurch als flaches Rechteck (bei 0,42 im Verhältnis 2,4 : 1), und der
   * runde Sichtkreis als Ellipse. Beides fiel im Spiel als „stimmt nicht" auf.
   *
   * Der Preis ist die Höhenwirkung: bei 1.0 steht kein Turm mehr sichtbar über
   * dem Rumpf (die Schwelle `h > beam · tilt / sqrt(1 − tilt²)` geht gegen
   * unendlich). Die Rumpfgrafiken selbst sind davon NICHT betroffen — sie
   * liegen in der aufrechten Ebene und werden nie gestaucht; nur ihre Position
   * wird umgerechnet.
   *
   * Zur Laufzeit über `setTilt()` verstellbar, im Dev-Build mit den Tasten
   * [ und ]. Dieser Wert ist nur der Startwert.
   */
  tilt: 1.0,
  /**
   * Untergrenze. Darunter kippt der Eindruck: ohne Perspektive schrumpfen
   * entfernte Dinge nicht, und ein Rumpf querab wird zum Strich (bei 0,25 noch
   * 3 px hoch). Zusätzlich wächst die anisotrope Texturstauchung auf 1/tilt.
   */
  minTilt: 0.25,
  /*
   * Zoom-Grenzen. Eng gefasst, weil beide Enden vorher nur Unsinn zeigten.
   *
   * UNTEN (0,25): bei 900 px Fensterhöhe sind das 3600 m Sicht — knapp mehr als
   * der Durchmesser des Sichtkreises (3750 m). Weiter herauszoomen zeigt
   * ausschließlich Verdunkelung: was dahinter liegt, verrät der Server ohnehin
   * nicht. Der alte Wert 0,03 fuhr die ganze 10.000er-Karte ins Bild und machte
   * jedes Schiff zu einem Punkt von zwei Pixeln.
   *
   * OBEN (1,1): rund 820 m Bildhöhe, die Fregatte misst darin 154 px. Darüber
   * verlässt man den Maßstab, in dem die Atlanten gerendert sind — die Frames
   * werden weich, und vom Gefecht sieht man nichts mehr.
   */
  minZoom: 0.25,
  maxZoom: 1.1,
  /**
   * Wie weit über der Fenstermitte das eigene Boot ruht, in Bildschirmpixeln.
   *
   * Die Anzeige ist unten schwerer als oben: Gefechtsleiste, Sonar und Telegraf
   * belegen rund 165 px, die Kopfleiste nur etwa 45. Die Mitte der FREIEN
   * Fläche liegt damit rund 60 px höher als die Mitte des Fensters — und dort
   * gehört das Boot hin.
   *
   * Ohne diesen Ausgleich verschwand es beim vollen Blick nach vorn hinter der
   * Waffenleiste (gemessen: Boot bei y = 678, Leistenoberkante 642). Mit ihm
   * bleibt es in JEDER Blickrichtung frei stehen.
   */
  shipLift: 60,
  /** Multiplikator pro Mausrad-Raste. */
  zoomStep: 1.15,
  /** Anteil des Viewports, den die Karte beim Start ausfüllt. */
  fitMargin: 0.88,
} as const;

/**
 * Aussehen der Wasserfläche. Farben als lineare RGB-Tripel für den Shader.
 *
 * Das Modell ist bewusst physikalisch motiviert statt „blau anmalen": Wasser
 * ist von sich aus fast schwarz, seine Farbe entsteht aus dem gespiegelten
 * HIMMEL (Fresnel) und dem Licht, das aus der Tiefe zurückstreut. Genau diese
 * beiden Anteile bestimmen die Werte hier.
 */
export const WATER = {
  /**
   * Rückstreuung aus dem Wasserkörper — die Farbe, die aus der Tiefe kommt.
   * Offener Ozean ist dabei tiefblau mit einem Rest Grün, NICHT reines Blau.
   */
  deep: [0.004, 0.022, 0.045],
  /** Flachere Zonen: das Grün nimmt zu, der Ton wird türkisiger. */
  shallow: [0.02, 0.1, 0.13],
  /**
   * Himmel für die Spiegelung: am Horizont dunstig-hell, im Zenit tiefer und
   * kühler. Beide werden über den reflektierten Strahl gemischt — das gibt der
   * Fläche ihre Tiefenstaffelung, ohne dass ein einziges Bild geladen würde.
   */
  skyHorizon: [0.62, 0.72, 0.82],
  skyZenith: [0.16, 0.31, 0.52],
  /** Farbe des Sonnenlichts für Glitzerpfad und Schaumbeleuchtung. */
  sunColor: [1.0, 0.94, 0.82],
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
  /**
   * Stärke der Verzerrungs-„Atmung" in Metern (Basis, skaliert mit dem
   * Seegang). Vor der Verstärkung: 34.
   */
  warpStrength: 58,
  /**
   * Tempo-Faktor für Drift und Verzerrung aller Lagen. 1 = das alte, sehr
   * gemächliche Tempo; der Wert wirkt live über die Uniforms.
   */
  driftSpeed: 1.7,
} as const;

/** Simulationstakt. Passt zum `tickRate`-Default 20 des Game-Servers. */
export const SIM = {
  fixedDt: 0.05,
  /** Deckelt das Aufholen nach einem Tab-Wechsel auf 0,25 s pro Frame. */
  maxCatchupSteps: 5,
} as const;

/**
 * Fahrleistung des eigenen Boots.
 *
 * Die Zahlen stehen jetzt in `@subwarfare/shared` (`sim/profiles.ts`) — der
 * **Server** rechnet damit und ist die Quelle der Wahrheit. Der Client braucht
 * sie nur für seine Anzeigen und den Offline-Demobetrieb, deshalb hier nur noch
 * ein Verweis statt einer zweiten Wertetabelle.
 */
export const VESSEL_DEMO: VesselProfile = DESTROYER;

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
 * Kielwasser: Schaumspur aus Schaum-Sprites + Bugwellen-V je Fahrzeug.
 * Client-seitig aus den interpolierten Positionen — keine Netzdaten.
 * Intensität ∝ Fahrt, getaucht (depth→1) verschwindet die Oberflächenspur.
 */
export const WAKE = {
  /**
   * Lebensdauer einer Schaumprobe in Sekunden.
   *
   * 22 s und nicht die früheren 3,5: bei Marschfahrt (~16 m/s) ergaben 3,5 s
   * ganze 56 m Spur — kürzer als das Schiff lang ist, weshalb praktisch kein
   * Kielwasser zu sehen war. Jetzt reicht die Spur ~350 m nach achtern und ist
   * damit auch beim Rauszoomen das, was Fahrt überhaupt sichtbar macht.
   */
  maxAgeSeconds: 22,
  /** Mindestabstand zwischen zwei Proben in Metern (begrenzt die Sprite-Zahl). */
  minSampleDistance: 11,
  foamColor: 0xe6f2f7,
  /** Deckkraft der frischen Spur direkt am Heck. */
  foamAlpha: 0.8,
  /**
   * Abklingexponent der Spur.
   *
   * Unter 1 (also langsamer als linear) und NICHT quadratisch: mit (1−t)² war
   * die Spur nach einem Drittel ihrer Länge optisch weg, egal wie lang man sie
   * leben ließ — der lange Schwanz ist aber gerade das, was Fahrt erzählt.
   */
  fadeExponent: 0.65,
  /**
   * Einblendzeit einer frischen Probe in Sekunden. Ohne sie stünde jeder
   * Batzen im Moment seines Ablegens mit voller Deckkraft da — die Spur
   * poppte sichtbar Stück für Stück hinters Heck. Mit der Rampe blüht der
   * Schaum auf, während das Schiff schon weiterfährt.
   */
  fadeInSeconds: 0.7,
  /**
   * Obergrenze der Proben je Fahrzeug — jede kostet drei Sprites.
   *
   * Bei Höchstfahrt reicht die Lebensdauer für gut 56 Proben; die Grenze
   * greift also nur, falls jemand später an Tempo oder Lebensdauer dreht.
   * Sie ist die Zusicherung, dass ein Fahrzeug nie mehr als ~220 Sprites
   * kostet, egal was in dieser Datei steht.
   */
  maxSamples: 70,
  /** Halbe Breite der frischen Spur in Schiffsbreiten … */
  spreadStart: 0.4,
  /** … und am Ende der Lebensdauer — die Spur läuft nach achtern auseinander. */
  spreadEnd: 2.4,
  /** Durchmesser eines Schaumbatzens in Schiffsbreiten, frisch bzw. alt. */
  puffStart: 2.1,
  puffEnd: 5.4,
  /** Deckkraft des Füllbatzens in der Spurmitte, relativ zu den Randbahnen. */
  centreAlpha: 0.6,
  // Das Bugwellen-V (Kelvin-Schenkel) ist bewusst raus: es las sich wie ein
  // Anbau am Rumpf statt wie Wasser. Vom Bug bleibt ein einzelner kleiner
  // Gischt-Tupfer (fest in drawFoam) — Fahrt erzählt die Heckspur.
  /** Deckkraft des Schattens, den der Rumpf aufs Wasser wirft. */
  shadowAlpha: 0.34,
} as const;

/**
 * Optische Sicht.
 *
 * REINE Darstellung: das Netz liefert ohnehin nur, was das Sonar ortet
 * (sensorRange server-seitig). Die optische Sicht ist kleiner — was das Sonar
 * hat, aber das Auge nicht, existiert als Echo auf dem Rundsichtgerät, nicht
 * als Schiff auf dem Wasser.
 */
export const VISION = {
  /**
   * Sichtradius an der Oberfläche in Metern. Schrumpft mit der Tauchtiefe.
   *
   * Deutlich kleiner als die Sonarreichweite (4000 m) — und das ist Absicht:
   * geortete Kontakte stehen im verdunkelten Ring, man weiß von ihnen, sieht
   * sie aber nicht klar. Genau dieser Abstand macht das Aufklären wertvoll.
   */
  radius: 1_875,
  /** Länge des Periskop-Sichtkegels in Metern. Wächst mit dem Ausfahren. */
  coneLength: 2_200,
  /** Halber Öffnungswinkel des Kegels in Grad. */
  coneHalfAngleDeg: 26,
  /** Deckkraft der Verdunkelung außerhalb der Sicht. */
  darkness: 0.62,
} as const;

/**
 * Lautstärken des Spiel-Sounds (0..1, multipliziert auf die Web-Audio-Gains).
 * Die Kulisse bleibt bewusst unter der Ereignis-Ebene: Abschüsse und
 * Einschläge müssen aus dem Dauerklang herausstechen.
 */
export const AUDIO = {
  /** Wasseroberfläche — leises Grundrauschen. */
  ambientWater: 0.22,
  /** Unter Wasser — dichter, darf präsenter sein. */
  ambientUnderwater: 0.4,
  /** Motor bei Höchstfahrt; skaliert linear mit |Fahrt| / Höchstfahrt. */
  engineMax: 0.4,
  fire: 0.65,
  impact: 0.8,
  /** Bergen einer Lootkiste — immer das eigene Boot, keine Entfernungsdämpfung. */
  loot: 0.55,
  /** Hörweite für Abschüsse/Einschläge in Metern — linearer Abfall auf 0. */
  hearingRangeMetres: 2_500,
} as const;

/**
 * Sonar-Rundsichtgerät (PPI).
 *
 * Der Strahl streicht im Uhrzeigersinn um und malt die Echos beim Überstreichen
 * frisch auf. Dazwischen steht das Bild still: ein Kontakt zeigt die Position
 * seines letzten Überstreichens, nicht seine aktuelle. Ein schnelles Ziel kann
 * dadurch bis zu eine Umlaufdauer veraltet sein.
 */
export const SONAR = {
  /**
   * Erfassungsreichweite in Metern — dieselbe Zahl, mit der der Server den
   * Netzverkehr filtert (`sensorRange` im Profil). Nicht hier ändern: eine
   * größere Anzeige-Reichweite bliebe leer, eine kleinere würde georteten
   * Kontakten die Anzeige verweigern.
   */
  range: DESTROYER.sensorRange,
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
 * Anzeige-Definition je Waffen-Kennung. WELCHE Waffen ein Schiff führt, sagt
 * der Server (ships-Tabelle, per welcome) — hier steht nur, wie eine Waffe
 * aussieht. `count` ist der Platzhalter für noch nicht server-verwaltete
 * Waffen; der Torpedo läuft live über das `own`-Ereignis (Kapazität aus
 * shared, damit Anzeige und Server nie auseinanderlaufen).
 */
export const WEAPON_SLOTS: Record<
  string,
  { label: string; short: string; count: number; icon: string }
> = {
  torpedo: { label: 'Torpedo', short: 'TRP', count: TORPEDO.capacity, icon: torpedoIcon },
  wasserbombe: { label: 'Wasserbombe', short: 'WBO', count: 24, icon: waterbombIcon },
  taeuschkoerper: { label: 'Täuschkörper', short: 'TKR', count: DECOY.capacity, icon: decoyIcon },
  geschuetz: { label: 'Geschütz', short: 'GES', count: GUN.capacity, icon: gunIcon },
};

/**
 * Rumpfmaße in Weltunits. Bug zeigt lokal nach -y.
 *
 * Aktuell die Fregatte (fregatte01). `length` ist die frei gewählte
 * Bezugsgröße — ändert man sie, skaliert das Schiff mit, weil der Maßstab der
 * Frames daraus folgt.
 */
export const HULL = {
  length: 140,
  beam: 25,
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

/**
 * Blickversatz zur Maus („peek").
 *
 * Die Kamera hängt fest am eigenen Boot — es gibt keine freie Ansicht mehr.
 * Umschauen geht über den Zeiger: je weiter er aus der Bildmitte steht, desto
 * weiter schiebt sich das Bild in seine Richtung. Lässt man ihn zurück in die
 * Mitte wandern, zieht sich der Versatz von selbst wieder zusammen. Vorbild ist
 * Foxhole, wo die Kamera ebenfalls dem Cursor nachgibt statt gezogen zu werden.
 *
 * Der Versatz ist BILDSCHIRM-Geometrie, kein Weltweg: er wird in `applyCamera`
 * auf die Verschiebung der Ebenen gerechnet. Dadurch bleibt er beim Zoomen
 * gleich groß, und Zielen wie Klicken rechnen automatisch richtig — sie gehen
 * über dieselbe Matrix.
 */
export const PEEK = {
  /**
   * Wie weit die Kamera dem Zeiger folgt, als Anteil der halben LÄNGEREN
   * Fensterkante — bei einem üblichen Breitbild also der Hälfte der Breite.
   *
   * Bewusst EIN Bezugsmaß für beide Achsen und nicht je Achse die eigene Kante:
   * sonst reicht der Blick nach oben und unten nur so weit, wie das Fenster
   * hoch ist. Bei 16:9 wären das kaum halb so viele Meter wie zur Seite — man
   * schaut in Fahrtrichtung voraus, und die zeigt genauso oft nach Norden wie
   * nach Osten. Mit dem gemeinsamen Bezug ist der Vorlauf in JEDE Richtung
   * gleich weit; die Zeigerstrecke dorthin ist kürzer, das Ziel dasselbe.
   *
   * Die Kappung wirkt radial: der Versatz erreicht in jeder Richtung höchstens
   * `strength · halbe lange Kante`, auch diagonal.
   */
  strength: 0.35,
  /**
   * Deckel für den SENKRECHTEN Versatz, als Anteil der halben Fensterhöhe.
   *
   * Das gemeinsame Bezugsmaß ist die halbe BREITE — auf einem sehr breiten
   * Fenster (21:9) überstiege der Versatz damit die kurze Höhe, und das Boot
   * verschwände unten hinter der Gefechtsleiste. 0,68 ist der Rest, der über
   * dem unteren Anzeigeblock (rund 165 px) und unter der Kopfleiste (45 px)
   * bleibt, samt `shipLift`. Auf 16:9 greift der Deckel nicht.
   */
  verticalCap: 0.68,
  /**
   * Totzone um die Bildmitte (Anteil der halben Kante). Ohne sie wackelt das
   * Bild bei jeder kleinen Handbewegung; der Rest wird nachskaliert, damit der
   * Übergang aus der Totzone heraus stetig bleibt.
   */
  deadzone: 0.1,
  /** Dämpfung wie bei der Nachführung: alpha = 1 - exp(-lambda * dt). */
  lambda: 7,
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

/**
 * Anzeigenamen der Karten.
 *
 * `GameMap` trägt nur eine `id` — der Name ist reine Darstellung und hat im
 * Protokoll nichts verloren. Er steht hier statt in den Views, weil ihn sowohl
 * die Kartenauswahl im Hauptmenü als auch die Statusleiste im Spiel brauchen;
 * getrennte Listen wären früher oder später auseinandergelaufen.
 */
export const MAP_LABELS: Record<string, string> = {
  ocean01: 'Nordatlantik',
  ocean02: 'Nordsee',
  ocean03: 'Persischer Golf',
  ocean04: 'Mittelmeer',
  ocean05: 'Barentssee',
};

/** Anzeigename einer Karte; unbekannte Kennungen zeigen sich selbst. */
export function mapLabel(id: string): string {
  return MAP_LABELS[id] ?? id;
}
