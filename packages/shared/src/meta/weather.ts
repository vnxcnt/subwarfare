/**
 * Wetter, Tageszeit und Seegang.
 *
 * Das sind **Karten-Parameter**, keine Client-Deko: der Server setzt sie je
 * Karte und schickt sie in der `welcome`. Der Client leitet daraus Sonnenstand,
 * Himmelsfarben und Wellenhöhe ab. Damit ist ein Nordatlantik bei bedecktem
 * Himmel und Seegang 6 eine andere Welt als Mittagssonne bei Flaute — mit
 * derselben Geometrie.
 *
 * Die Ableitung liegt hier in `shared` und nicht im Shader, aus zwei Gründen:
 * sie ist prüfbar (reine Funktion, ein paar Mischungen), und Server wie Menü
 * können später dieselben Werte lesen, ohne GLSL zu übersetzen.
 */

/** RGB als lineares Tripel — dieselbe Konvention wie `WATER` im Client. */
export type Rgb = [number, number, number];

/**
 * Spielwirkung des Seegangs.
 *
 * Die Leitidee ist eine Asymmetrie, die sich aus der Sache selbst ergibt:
 * **Schwere See begünstigt das U-Boot.** Ein rollendes Deck kann keine Peilung
 * halten, und Oberflächenlärm frisst die Ortung — ein getauchtes Boot liegt
 * dagegen ruhig und hört besser. Damit wird das Wetter einer Karte zu einer
 * strategischen Aussage statt zu Kulisse.
 */
export const WEATHER_EFFECTS = {
  /**
   * Streuung beim Schießen vom rollenden Deck in Grad (bei Seegang 1, voll
   * aufgetaucht). 4° klingen wenig, sind auf 1.200 m Geschützreichweite aber
   * rund 80 m Ablage — spürbar, ohne das Zielen sinnlos zu machen.
   */
  maxAimSpreadDeg: 4,
  /** Anteil, um den schwere See die Sonarreichweite kürzt (bei Seegang 1). */
  maxSonarLoss: 0.3,
  /**
   * Wie stark Tauchen den Sonar-Nachteil abfedert. 0,7 heißt: ein voll
   * getauchtes Boot behält 70 % des Verlusts nicht — es hört fast wie bei
   * Flaute.
   */
  submergedSonarRelief: 0.7,
} as const;

/**
 * Streuung eines Schusses in Grad. `depth` ist die Tauchtiefe des SCHÜTZEN:
 * Wer unter der Oberfläche liegt, rollt nicht und schießt sauber.
 */
export function aimSpreadDeg(seaState: number, depth: number): number {
  const see = Math.min(Math.max(seaState, 0), 1);
  const tiefe = Math.min(Math.max(depth, 0), 1);
  return WEATHER_EFFECTS.maxAimSpreadDeg * see * (1 - tiefe);
}

/**
 * Wirksame Sonarreichweite unter Seegang. `depth` ist die Tiefe des
 * HORCHENDEN — unter der Oberfläche stört der Wellenlärm weniger.
 */
export function effectiveSensorRange(base: number, seaState: number, depth: number): number {
  const see = Math.min(Math.max(seaState, 0), 1);
  const tiefe = Math.min(Math.max(depth, 0), 1);
  const verlust =
    WEATHER_EFFECTS.maxSonarLoss * see * (1 - tiefe * WEATHER_EFFECTS.submergedSonarRelief);
  return base * (1 - verlust);
}

export interface WeatherState {
  /**
   * Seegang 0 (spiegelglatt) bis 1 (schwer). Skaliert Wellenhöhe UND
   * Schaummenge — der einzige Wert, der schon vorher existierte.
   */
  seaState: number;
  /** Tageszeit in Stunden, 0..24. 12 = Mittag. */
  timeOfDay: number;
  /** Bewölkung 0 (klar) bis 1 (geschlossene Decke). */
  cloudCover: number;
  /**
   * Länge eines vollen Spieltages in MINUTEN. 0 lässt die Uhr stehen — dann
   * ist `timeOfDay` eine feste Stimmung. Läuft sie, rechnet der Client sie aus
   * der `welcome` selbst hoch; über das Netz geht dafür nichts.
   */
  dayLengthMinutes: number;
}

/**
 * Benannte Wetterlagen. Eine Karte verweist auf eine davon (oder setzt eigene
 * Werte) — so bleibt „Nordatlantik" eine Entscheidung und keine Zahlenkolonne.
 */
export const WEATHER_PRESETS = {
  /** Hoher Mittag, kaum Wolken, ruhige See. Referenzlage zum Vergleichen. */
  klarer_tag: { seaState: 0.35, timeOfDay: 12, cloudCover: 0.1, dayLengthMinutes: 0 },
  /** Die Stimmung des Vorbilds: bedeckt, grau, rau. */
  nordatlantik: { seaState: 0.7, timeOfDay: 10.5, cloudCover: 0.75, dayLengthMinutes: 0 },
  /** Geschlossene Decke, schwere See — kaum Schatten, viel Schaum. */
  sturm: { seaState: 1, timeOfDay: 14, cloudCover: 0.95, dayLengthMinutes: 0 },
  /**
   * Tiefstehende Sonne, langer Glitzerpfad. 17,2 h liegt bewusst KNAPP VOR
   * dem Untergang (18 h) — danach ist es nur noch dunkel, nicht golden.
   */
  daemmerung: { seaState: 0.45, timeOfDay: 17.2, cloudCover: 0.25, dayLengthMinutes: 0 },
  /** Mondlicht: dunkel, aber nie schwarz — man muss noch fahren können. */
  nacht: { seaState: 0.5, timeOfDay: 1.5, cloudCover: 0.3, dayLengthMinutes: 0 },
} as const satisfies Record<string, WeatherState>;

export type WeatherPreset = keyof typeof WEATHER_PRESETS;

export const DEFAULT_WEATHER: WeatherState = WEATHER_PRESETS.nordatlantik;

/**
 * Bringt eine von außen gereichte Wetterlage in gültige Grenzen.
 *
 * Der Server ruft das bei JEDEM `dev:weather` — auch ein Entwickler-Befehl ist
 * eine Absicht, kein Zustand: sonst könnte ein gebasteltes Ereignis mit
 * `seaState: 1e9` oder `NaN` die Wellen und die Streuung zerlegen.
 */
export function sanitizeWeather(raw: unknown): WeatherState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const w = raw as Partial<Record<keyof WeatherState, unknown>>;
  const zahl = (wert: unknown, min: number, max: number): number | null => {
    if (typeof wert !== 'number' || !Number.isFinite(wert)) return null;
    return Math.min(Math.max(wert, min), max);
  };

  const seaState = zahl(w.seaState, 0, 1);
  const timeOfDay = zahl(w.timeOfDay, 0, 24);
  const cloudCover = zahl(w.cloudCover, 0, 1);
  // Obergrenze, damit eine absurde Taglänge die Uhr nicht praktisch anhält.
  const dayLengthMinutes = zahl(w.dayLengthMinutes, 0, 1440);
  if (seaState === null || timeOfDay === null || cloudCover === null || dayLengthMinutes === null) {
    return null;
  }
  return { seaState, timeOfDay, cloudCover, dayLengthMinutes };
}

/**
 * Tageszeit zum Zeitpunkt `elapsedSeconds` nach der Übergabe.
 * Steht die Uhr (`dayLengthMinutes` 0), bleibt es bei der Ausgangszeit.
 */
export function currentHour(weather: WeatherState, elapsedSeconds: number): number {
  if (weather.dayLengthMinutes <= 0) return weather.timeOfDay;
  const stundenProSekunde = 24 / (weather.dayLengthMinutes * 60);
  return (((weather.timeOfDay + elapsedSeconds * stundenProSekunde) % 24) + 24) % 24;
}

/** Sonnenstand: Höhe über dem Horizont in Grad, negativ = untergegangen. */
export function sunElevation(hour: number): number {
  // Einfaches Bogenmodell: Aufgang 6, Höchststand 12, Untergang 18. Für ein
  // Seekriegsspiel auf mittleren Breiten reicht das — ein astronomisches
  // Modell mit Datum und Breitengrad wäre Genauigkeit ohne Spielwert.
  const MAX_ELEVATION = 52;
  return MAX_ELEVATION * Math.sin((Math.PI * (hour - 6)) / 12);
}

/** Sonnenpeilung in Grad (0 = Nord, im Uhrzeigersinn): Ost früh, West spät. */
export function sunBearing(hour: number): number {
  // 06:00 Ost (90°), 12:00 Süd (180°), 18:00 West (270°).
  return (((90 + (hour - 6) * 15) % 360) + 360) % 360;
}

export interface Atmosphere {
  /** Richtung ZUR Sonne als Weltvektor (x Ost, y Süd, z oben). */
  sunDirection: Rgb;
  sunColor: Rgb;
  skyHorizon: Rgb;
  skyZenith: Rgb;
  /**
   * Wie stark die Sonne als GERICHTETE Quelle wirkt, 0..1. Wolken dämpfen sie;
   * bei geschlossener Decke bleibt nur noch diffuses Himmelslicht, und damit
   * verschwindet der Glitzerpfad — genau wie in Wirklichkeit.
   */
  sunStrength: number;
  /** Physikalische Helligkeit 0..1 für den Wasserkörper (Tageszeit × Wolken). */
  lightLevel: number;
  /**
   * Belichtung. Bildet die Anpassung des Auges an die Umgebungshelligkeit ab:
   * eine Nachtszene IST physikalisch fast schwarz, wirkt aber nicht so, weil
   * das Auge adaptiert. Ohne diesen Faktor wäre die Nacht realistisch und
   * unspielbar; mit ihm bleibt sie dunkel, aber lesbar.
   *
   * Angewandt wird sie GANZ AM ENDE auf die fertige Farbe — sie hebt Wasser,
   * Spiegelung und Schaum gemeinsam an und lässt deren Verhältnis zueinander
   * unangetastet.
   */
  exposure: number;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.min(Math.max(t, 0), 1);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function smoothstep(kante0: number, kante1: number, wert: number): number {
  const t = Math.min(Math.max((wert - kante0) / (kante1 - kante0), 0), 1);
  return t * t * (3 - 2 * t);
}

/* Farbstützstellen. Bewusst als benannte Konstanten: an ihnen wird gedreht,
   wenn eine Stimmung nicht sitzt — nicht in der Formel darunter. */
const NACHT_SONNE: Rgb = [0.28, 0.34, 0.5];
const GOLD_SONNE: Rgb = [1, 0.6, 0.3];
const TAG_SONNE: Rgb = [1, 0.95, 0.86];

const NACHT_HORIZONT: Rgb = [0.08, 0.11, 0.17];
const GOLD_HORIZONT: Rgb = [0.8, 0.48, 0.32];
const TAG_HORIZONT: Rgb = [0.62, 0.72, 0.82];

const NACHT_ZENIT: Rgb = [0.035, 0.05, 0.1];
const GOLD_ZENIT: Rgb = [0.2, 0.26, 0.45];
const TAG_ZENIT: Rgb = [0.16, 0.31, 0.52];

/**
 * Leitet Sonnenstand, Himmelsfarben und Helligkeit aus Tageszeit und
 * Bewölkung ab.
 *
 * Der Ablauf ist bewusst zweistufig: erst die KLARE Atmosphäre über den
 * Sonnenstand, dann die Bewölkung darüber. So bleibt „was macht die Uhrzeit"
 * von „was machen die Wolken" getrennt und beide Regler bleiben verständlich.
 */
export function atmosphereFor(weather: WeatherState, hour: number): Atmosphere {
  const elevationDeg = sunElevation(hour);
  const elevation = Math.sin((elevationDeg * Math.PI) / 180);
  const bearing = (sunBearing(hour) * Math.PI) / 180;

  // Unter dem Horizont bleibt die Richtung stehen (knapp über der Kimm) —
  // sonst käme das Licht von unten durchs Wasser.
  const richtungsHoehe = Math.max(elevation, 0.06);
  const waagerecht = Math.sqrt(Math.max(1 - richtungsHoehe * richtungsHoehe, 0));
  const sunDirection: Rgb = [
    Math.sin(bearing) * waagerecht,
    -Math.cos(bearing) * waagerecht,
    richtungsHoehe,
  ];

  // Tag/Nacht und die goldene Stunde als zwei getrennte Blenden.
  const tag = smoothstep(-0.05, 0.28, elevation);
  const gold = smoothstep(-0.12, 0.06, elevation) * (1 - smoothstep(0.06, 0.4, elevation));

  let sunColor = mix(NACHT_SONNE, TAG_SONNE, tag);
  let skyHorizon = mix(NACHT_HORIZONT, TAG_HORIZONT, tag);
  let skyZenith = mix(NACHT_ZENIT, TAG_ZENIT, tag);
  sunColor = mix(sunColor, GOLD_SONNE, gold);
  skyHorizon = mix(skyHorizon, GOLD_HORIZONT, gold);
  skyZenith = mix(skyZenith, GOLD_ZENIT, gold);

  // Bewölkung: alles zieht zu einem gleichmäßigen Grau, dessen Helligkeit an
  // der Tageszeit hängt. Der Unterschied zwischen Horizont und Zenit
  // verschwindet dabei fast — eine Wolkendecke ist ein flacher Leuchtkörper.
  const wolken = Math.min(Math.max(weather.cloudCover, 0), 1);
  // Dichtere Decke heißt DUNKLER, nicht nur grauer — eine Sturmwolke lässt
  // weniger durch als ein Schleier.
  const grauwert = (0.1 + 0.42 * tag) * (1 - wolken * 0.28);
  const grau: Rgb = [grauwert * 0.94, grauwert * 0.99, grauwert * 1.06];
  skyHorizon = mix(skyHorizon, [grau[0] * 1.15, grau[1] * 1.15, grau[2] * 1.15], wolken * 0.9);
  skyZenith = mix(skyZenith, [grau[0] * 0.8, grau[1] * 0.8, grau[2] * 0.85], wolken * 0.9);
  sunColor = mix(sunColor, grau, wolken * 0.8);

  // Physikalische Helligkeit: Tageszeit mal Wolkendecke.
  const licht = (0.26 + 0.74 * tag) * (1 - wolken * 0.35);

  return {
    sunDirection,
    sunColor,
    skyHorizon,
    skyZenith,
    // Die letzten Prozent bleiben stehen: auch unter geschlossener Decke ist
    // die Richtung, aus der es heller ist, noch zu ahnen.
    sunStrength: (0.08 + 0.92 * tag) * (1 - wolken * 0.92),
    // Auch die Grundhelligkeit hängt an der Decke: ein Sturmmittag ist
    // spürbar düsterer als ein klarer, sonst unterscheiden sich die Lagen nur
    // im Glitzerpfad.
    //
    lightLevel: licht,
    // Adaption: nur ein Teil des Helligkeitsverlusts wird ausgeglichen
    // (Exponent 0,4). Der Rest bleibt sichtbar — sonst sähen alle Wetterlagen
    // gleich hell aus und die Regler wären wirkungslos.
    exposure: Math.pow(licht, -0.4),
  };
}
