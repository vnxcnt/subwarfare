import type { Atmosphere, GameMap } from '@subwarfare/shared';
import { Geometry, Mesh, Shader, Texture } from 'pixi.js';
import { WATER } from '../config';
import { oceanWaterTexture } from './fx-textures';
import type { IslandField } from './IslandField';
import { buildIslandField, loadTerrainTextures } from './IslandField';
import { getTilt } from './Projection';

/*
 * Hinweis zum GLSL-Dialekt: Ohne `#version 300 es` im FRAGMENT bleibt Pixi im
 * GLSL-ES-1.00-Pfad und injiziert die Kompatibilitäts-Defines
 * (`in` -> attribute/varying, `finalColor` -> gl_FragColor, `texture` ->
 * texture2D). Das ist der robuste Weg, der auch auf einem WebGL1-Fallback
 * compiliert. `out vec4 finalColor;` muss dabei zeichengenau so geschrieben
 * sein — Pixi entfernt exakt diese Zeichenfolge per String-Replace.
 */

const vertex = `
in vec2 aPosition;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out vec2 vWorld;

void main() {
  vWorld = aPosition;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}
`;

/*
 * ⚠️ KEINE BACKTICKS in diesem Shader — er lebt in einem Template-Literal und
 * jeder Backtick beendet es mitten im GLSL.
 * ⚠️ "patch" ist in GLSL ES 3.00 ein RESERVIERTES Wort (Tessellation).
 */
const fragment = `
in vec2 vWorld;
out vec4 finalColor;

uniform float uTime;
uniform float uZoom;
uniform float uSeaState;
uniform float uTilt;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSun;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform vec3 uSunColor;
/** Wie stark die Sonne GERICHTET wirkt — Wolken dämpfen sie bis fast auf null. */
uniform float uSunStrength;
/** Physikalische Helligkeit des Wasserkörpers (Tageszeit × Wolken). */
uniform float uLightLevel;
/** Belichtung — Anpassung ans Umgebungslicht, ganz am Ende angewandt. */
uniform float uExposure;
/** Stärke der Verzerrungs-„Atmung" in Metern (WATER.warpStrength). */
uniform float uWarpStrength;
/** Tempo-Faktor für Drift und Verzerrung aller Lagen (WATER.driftSpeed). */
uniform float uDrift;
/**
 * Rebase-Offsets der Endlos-Karte, je Abtastlage einer (siehe applyRebase):
 * verschiebt der Client alle Weltkoordinaten um eine Kartenlänge, gleichen
 * diese Offsets die UV-Verschiebung exakt aus — das Wasserbild bleibt im
 * Rebase-Frame IDENTISCH, auch für die gedrehten Lagen.
 */
uniform vec2 uOffWarp;
uniform vec2 uOffWarp2;
uniform vec2 uOffWeit;
uniform vec2 uOffGrob;
uniform vec2 uOffFein;
uniform vec2 uOffTiefe;
uniform vec2 uOffLand;
uniform vec2 uOffBrandung;
uniform vec2 uOffStrand;
uniform vec2 uOffSand;
uniform vec2 uOffSand2;
uniform vec2 uOffGras;

/**
 * Die Wasseroberfläche als FARBIGE Kachel — eine echte Wasseraufnahme, von
 * tools/ocean-texture.py nahtlos gemacht. Sie wird ANGEZEIGT, nicht
 * nachgerechnet: Wellen, Kämme und Schaum stecken bereits darin.
 */
uniform sampler2D uWater;

/**
 * KÜSTE. 0 auf Karten ohne Landmassen (ocean01) — dann läuft kein einziger
 * Schritt des Küstenblocks, und das Wasserbild ist Zahl für Zahl das alte.
 * Der Zweig hängt an einem UNIFORM und ist damit für alle Bildpunkte gleich;
 * es gibt keine auseinanderlaufenden Lanes und keine kaputten Ableitungen.
 */
uniform float uLandAn;
/** Abstandsfeld der Küste — siehe game/IslandField.ts. */
uniform sampler2D uLand;
/** Kehrwert der Kartengröße: Weltkoordinate -> Feld-UV. */
uniform vec2 uLandInv;
/** Feldgröße in Zellen — für die von Hand gerechnete bilineare Mischung. */
uniform vec2 uLandZellen;
/** Abstandsbereich der Kodierung in Metern (±). */
uniform float uLandReichweite;
/** Bodentexturen des Landes, in Weltkoordinaten gekachelt. */
uniform sampler2D uSand;
uniform sampler2D uGras;

/** Dreht einen Punkt um den Ursprung — bricht die Ausrichtung der Lagen auf. */
vec2 dreh(vec2 p, float w) {
  float c = cos(w);
  float s = sin(w);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

/**
 * Eine Farbe auf Helligkeit 1 normieren, damit sie nur noch FÄRBT.
 *
 * ⚠️ Ohne das wird jede Tönung zur Verdunkelung: Himmels- und Wasserfarben
 * liegen alle bei 0,05..0,3, und das Kachelbild ist selbst schon dunkles
 * Marineblau. Multipliziert man beides, kommt Schwarz heraus — genau das ist
 * beim ersten Versuch passiert, die ganze Tafel war praktisch unsichtbar.
 */
vec3 nurFarbe(vec3 c) {
  float l = max(dot(c, vec3(0.299, 0.587, 0.114)), 0.001);
  return c / l;
}

/*
 * DAS KÜSTENBILD, in Metern Abstand zur Wasserlinie. Vorzeichen wie in shared:
 * POSITIV seewärts, NEGATIV landeinwärts.
 *
 * Die Werte stammen aus einem abgenommenen Mockup. Sie stehen hier und nicht in
 * config, weil sie EIN Bild beschreiben und nur zusammen sinnvoll sind — wer am
 * Strand dreht, muss den Bewuchs mitdrehen, sonst wandert die Grenze ins Wasser.
 */
/** Farbsaum über dem Schelf: so weit steht das Wasser sichtbar heller. */
const float KUESTE_FLACHWASSER = 430.0;
/** Brandungsband, seewärtiges und landeinwärtiges Ende. */
const float KUESTE_BRANDUNG_SEE = 34.0;
const float KUESTE_BRANDUNG_LAND = -4.0;
/** Breite des weichen Übergangs zwischen Wasser und Land. */
const float KUESTE_WASSERLINIE = 16.0;
/** So weit landeinwärts hält die auflaufende See den Sand dunkel. */
const float KUESTE_NASS = 70.0;
/** Nasser Sand ist rund 30 % dunkler als trockener. */
const float KUESTE_NASS_DUNKEL = 0.70;
/** Strandbreite bis zum Bewuchs und die Breite des Übergangs dorthin. */
const float KUESTE_STRAND = 95.0;
const float KUESTE_GRAS_UEBERGANG = 55.0;
/** Streuung der Strandbreite — ohne sie läuft die Bewuchsgrenze wie gezirkelt. */
const float KUESTE_STRAND_RAUSCHEN = 55.0;
/** Kantenlänge der Boden-Kacheln in Metern. */
const float KUESTE_KACHEL = 520.0;
/** Gesamthelligkeit des Bodens gegenüber der Vorlage. */
const float KUESTE_BODEN_HELL = 0.85;

/**
 * Wertrauschen aus der Weltkoordinate, 0..1.
 *
 * ⚠️ NICHT die Wasserkachel nehmen, so wie es die Wellenlagen tun. Für die
 * Wellenlängen der Küste (165 m und 2600 m) wird sie stark VERKLEINERT
 * abgetastet, und die Mip-Stufen mitteln ihre Streuung weg: gemessen 0,028
 * Standardabweichung roh, 0,011 auf Stufe 3. Von den gewollten ±55 m
 * Strandbreite blieben damit ±3 m übrig — die Bewuchsgrenze lief exakt parallel
 * zur Küste, also genau der Zirkelstrich, den das Rauschen verhindern soll.
 * Schlimmer noch: wie stark gemittelt wird, hängt am ZOOM, der Strand hätte
 * beim Heranfahren seine Breite geändert.
 */
float hashRauschen(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float wertRauschen(vec2 p) {
  vec2 gitter = floor(p);
  vec2 f = p - gitter;
  // Smootherstep statt smoothstep: auch die zweite Ableitung ist stetig. Sonst
  // zeichnen sich die Gitterlinien des Rauschens als Knicke im Strand ab.
  vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hashRauschen(gitter);
  float b = hashRauschen(gitter + vec2(1.0, 0.0));
  float c = hashRauschen(gitter + vec2(0.0, 1.0));
  float d = hashRauschen(gitter + vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

/**
 * Zwei Oktaven, auf die volle Breite 0..1 gespreizt.
 *
 * ⚠️ Die Spreizung ist nötig, nicht kosmetisch: interpoliertes Wertrauschen
 * drängt sich um 0,5 (Standardabweichung rund 0,17), und zwei gemittelte
 * Oktaven noch enger. Ohne den Faktor käme von einer verlangten Streuung nur
 * etwa ein Drittel an.
 */
float rauschenFbm(vec2 p) {
  float r = wertRauschen(p) * 0.65 + wertRauschen(p * 2.17 + vec2(19.3, 7.7)) * 0.35;
  return clamp((r - 0.5) * 3.4 + 0.5, 0.0, 1.0);
}

/** Einen Feldwert dekodieren: zwei Bytes -> Meter. */
float landWert(vec2 uv) {
  vec2 rg = texture(uLand, uv).rg;
  return (dot(rg, vec2(65280.0, 255.0) / 65535.0) * 2.0 - 1.0) * uLandReichweite;
}

/**
 * Abstand zur Küste in Metern — negativ an Land, positiv auf Wasser.
 *
 * ⚠️ Die vier Nachbarn werden hier VON HAND gemischt, und das Feld wird
 * punktgenau abgetastet. Der Wert steckt in zwei Bytes; ein bilinearer Sampler
 * würde hohes und niedriges Byte getrennt mitteln, und wo das niedrige von 255
 * auf 0 überspringt, käme ein Sprung über den halben Wertebereich heraus — ein
 * Ring aus Sprenkeln entlang jeder Küste.
 */
float landAbstand(vec2 welt) {
  vec2 uv = welt * uLandInv + uOffLand;
  vec2 zelle = uv * uLandZellen - 0.5;
  vec2 basis = floor(zelle);
  vec2 anteil = zelle - basis;
  vec2 schritt = 1.0 / uLandZellen;
  vec2 uv0 = (basis + 0.5) * schritt;
  float a = landWert(uv0);
  float b = landWert(uv0 + vec2(schritt.x, 0.0));
  float c = landWert(uv0 + vec2(0.0, schritt.y));
  float d = landWert(uv0 + schritt);
  return mix(mix(a, b, anteil.x), mix(c, d, anteil.x), anteil.y);
}

void main() {
  float see = uSeaState;

  /*
   * VERZERRUNG. Dieselbe Kachel, sehr grob abgetastet und langsam wandernd,
   * verschiebt die Abtastkoordinate der sichtbaren Lagen. Das ist derselbe
   * Kunstgriff wie ein Displacement-Filter: das Bild bleibt das Bild, es
   * atmet nur. Ohne diesen Schritt sähe die Fläche aus wie ein gemustertes
   * Tuch, das über den Bildschirm geschoben wird.
   */
  float zeit = uTime * uDrift;
  vec2 warpUV = vWorld * (1.0 / 430.0) + vec2(0.0042, -0.0029) * zeit + uOffWarp;
  vec2 warp = (texture(uWater, warpUV).rg - 0.5) * (uWarpStrength * (0.30 + 0.70 * see));

  /*
   * ZWEITE Verzerrungslage, gegenläufig und auf anderem Maßstab: zwei
   * interferierende Felder lassen die Fläche sichtbar ROLLEN, wo eine einzelne
   * Lage nur gleichförmig schiebt. Andere Kanäle (gb) derselben Kachel, damit
   * die beiden Felder nicht korrelieren.
   */
  vec2 warpUV2 = dreh(vWorld, 0.9) * (1.0 / 233.0) - vec2(0.0036, 0.0027) * zeit + uOffWarp2;
  warp += (texture(uWater, warpUV2).gb - 0.5) * (uWarpStrength * 0.55 * (0.30 + 0.70 * see));

  /*
   * ZWEI MASSSTÄBE derselben Kachel, gegeneinander verdreht und
   * unterschiedlich schnell driftend. Ein einzelner Maßstab wäre als Raster
   * erkennbar; das krumme Größenverhältnis (255 : 61) verhindert, dass die
   * beiden Raster periodisch zusammenfallen.
   */
  vec2 pWeit = dreh(vWorld + warp * 1.4, -0.55) * (1.0 / 940.0)
             + vec2(0.0004, 0.0003) * zeit + uOffWeit;
  vec2 pGrob = (vWorld + warp) * (1.0 / 255.0) + vec2(0.0011, 0.0008) * zeit + uOffGrob;
  vec2 pFein = dreh(vWorld + warp * 0.55, 1.05) * (1.0 / 61.0)
             + vec2(-0.0034, 0.0023) * zeit + uOffFein;

  vec3 weit = texture(uWater, pWeit).rgb;
  vec3 grob = texture(uWater, pGrob).rgb;
  vec3 fein = texture(uWater, pFein).rgb;

  /*
   * DER MASSSTAB FOLGT DEM ZOOM. Eine feste Kachelgröße kann den Zoombereich
   * von 0,03 bis 4 nicht bedienen: was nah richtig aussieht, wiederholt sich in
   * der Übersicht als sichtbares Gewebe, und was in der Übersicht passt, ist
   * nah ein verwaschener Fleck. Deshalb übernimmt beim Rauszoomen die weite
   * Lage, und die feine wird nur eingeblendet, wenn die Auflösung sie hergibt —
   * sonst alisiert ihre Struktur zu einem flimmernden Teppich.
   */
  float wGrob = smoothstep(0.55, 1.60, uZoom);
  float wFein = 0.45 * smoothstep(0.30, 1.30, uZoom);
  vec3 wasser = mix(mix(weit, grob, wGrob), fein, wFein);

  /*
   * ⚠️ KONTRAST ZURÜCKGEBEN. Das Mischen unabhängiger Abtastungen mittelt sie
   * einander weg: bei den Gewichten a, b, c bleibt nur a²+b²+c² der Varianz
   * übrig. Genau in der mittleren Zoomstufe überlagern sich alle drei Lagen,
   * und dort — also beim üblichen Spielzoom — sah die See sichtbar flacher aus
   * als eine Stufe darüber oder darunter. Der Kehrwert der Wurzel stellt die
   * ursprüngliche Streuung wieder her; gespreizt wird um die gemessenen
   * Kanalmittel der Kachel.
   */
  float aWeit = (1.0 - wGrob) * (1.0 - wFein);
  float aGrob = wGrob * (1.0 - wFein);
  float kontrast = inversesqrt(aWeit * aWeit + aGrob * aGrob + wFein * wFein);
  /*
   * Kanalmittel der Kachel. Bezugspunkt der Kontrastspreizung — es muss NICHT
   * bei jedem Vorlagenwechsel nachgezogen werden, weil tools/ocean-texture.py
   * die Kachel auf eine feste Zielstatistik normiert (siehe ZIEL_MITTEL dort).
   * Ohne diese Normierung hätte eine helle, flaue Vorlage gar keine Kämme mehr
   * und eine grelle Fläche ergeben.
   */
  vec3 kachelMittel = vec3(0.122, 0.182, 0.224);
  wasser = max((wasser - kachelMittel) * kontrast + kachelMittel, vec3(0.0));

  /*
   * SEEGANG. Die Kachel zeigt eine Wetterlage; der Seegang spreizt sie. Bei
   * ruhiger See werden die Kämme zurückgenommen, bei Sturm herausgezogen —
   * so unterscheiden sich Flaute und Sturm sichtbar, ohne dass es zwei
   * Texturen bräuchte.
   */
  float hell = dot(wasser, vec3(0.299, 0.587, 0.114));
  float kamm = smoothstep(0.20, 0.62, hell);
  wasser = mix(wasser * (0.82 + 0.18 * kamm), wasser * (1.0 + 0.85 * kamm), see);
  /*
   * ⚠️ Die Spreizung muss den KONTRAST anheben, nicht die Helligkeit. Ohne
   * diesen Ausgleich hellt sie den Sturm um 13 % auf und hebt damit fast exakt
   * die 9 % auf, die er über das geringere Licht dunkler sein sollte — gemessen
   * blieben zwischen klarem Tag und Sturm ganze 3 % Unterschied übrig. Ein
   * Sturm gehört rauer UND dunkler, nicht nur rauer.
   */
  wasser /= 1.0 + 0.40 * see;

  /*
   * Großräumige Farb- und Helligkeitsvariation: eine sehr flache Abtastung
   * derselben Kachel. Sie wirkt als HELLIGKEIT und als reine Tönung, nicht als
   * Multiplikator mit der Wasserfarbe — sonst verdunkelt sie die Fläche.
   */
  float tiefe = smoothstep(0.25, 0.75, texture(uWater, vWorld * (1.0 / 5200.0) + vec2(0.11, 0.37) + uOffTiefe).b);
  vec3 wasserton = nurFarbe(mix(uShallow, uDeep, tiefe));
  wasser = mix(wasser, wasser * wasserton, 0.35) * mix(1.12, 0.88, tiefe);

  /*
   * WETTER. Die Kachel bringt ihr eigenes Blau mit — das Wetter FÄRBT und
   * HELLT sie, statt sie zu ersetzen. Genau daran ist die vorherige Fassung
   * gescheitert: sie rechnete die Farbe komplett neu, und von der Vorlage
   * blieb nichts übrig als ein Höhenrelief.
   */
  vec3 himmel = mix(uSkyHorizon, uSkyZenith, 0.35);
  vec3 tint = nurFarbe(mix(himmel, uSunColor, uSunStrength * 0.45));
  /*
   * ⚠️ KEIN Helligkeitssockel. Mit "(0.45 + 0.55 * uLightLevel)" war die NACHT
   * HELLER als der Tag: uExposure hebt dunkle Szenen an (lightLevel hoch -0,4),
   * und der Sockel verhinderte, dass das Licht überhaupt so weit fällt, wie die
   * Belichtung es wieder anhebt. Der Exponent lässt beide gegeneinander laufen
   * und ergibt netto einen sanften, aber richtig herum wirkenden Abfall.
   */
  /*
   * ⚠️ Die Tönung darf die Bewölkung NICHT allein tragen. "nurFarbe" normiert
   * auf Helligkeit 1, und vec3(1.0) hat mit denselben Gewichten ebenfalls
   * Helligkeit 1 — die Mischung aus beiden hat also IMMER exakt Helligkeit 1
   * und kann konstruktionsbedingt nichts aufhellen oder abdunkeln. Ohne den
   * Faktor aus uSunStrength unterschied sich ein klarer Mittag von einem
   * geschlossen bewölkten Himmel um unter 2 % je Farbkanal.
   */
  /*
   * Der gemeinsame Lichtfaktor. Als eigene Größe herausgezogen, weil das LAND
   * weiter unten exakt dasselbe Licht bekommen muss: sonst steht bei Nacht oder
   * im Sturm eine taghell beleuchtete Insel in dunkler See.
   */
  vec3 licht = mix(vec3(1.0), tint, 0.28)
             * pow(max(uLightLevel, 0.001), 0.8)
             * (0.72 + 0.38 * uSunStrength)
             * 1.15;
  vec3 col = wasser * licht;

  /*
   * Sonnenglanz auf den Kämmen. Der Blickvektor ist bei einer Parallel-
   * projektion für jeden Punkt gleich, deshalb reicht die Sonnenhöhe als Maß:
   * steht sie tief, zieht sich der Glanz zusammen.
   */
  float sonnenhoehe = clamp(normalize(uSun).z, 0.0, 1.0);
  float glanz = pow(kamm, 2.2) * uSunStrength * (0.35 + 0.65 * sonnenhoehe);
  col += uSunColor * glanz * 0.45 * smoothstep(0.20, 0.85, uZoom);

  // Diffuses Himmelslicht — ohne diesen Anteil wirkt Wasser abseits von Sonne
  // und Spiegelung wie Tinte statt wie See.
  vec3 umgebung = mix(uSkyZenith, uSkyHorizon, 0.5) * 0.07;
  col += umgebung;

  /*
   * KÜSTE. Alles ab hier hängt an einer einzigen Zahl: dem vorzeichenbehafteten
   * Abstand zur Wasserlinie. Es wird keine Kante gezeichnet und keine Geometrie
   * angefasst — Flachwasser, Brandung, Strand und Bewuchs sind Bänder um die
   * Null dieses Feldes.
   */
  if (uLandAn > 0.5) {
    float kueste = landAbstand(vWorld);

    /*
     * FLACHWASSER. Über dem Schelf steht weniger Wasser über dem Grund, die
     * Rückstreuung wird heller und grüner. Das ist der Saum, an dem man eine
     * Insel schon erkennt, bevor sie überhaupt im Bild ist — und damit die
     * einzige Vorwarnung, die ein Kapitän auf Sicht bekommt.
     */
    float flach = 1.0 - smoothstep(0.0, KUESTE_FLACHWASSER, max(kueste, 0.0));
    col = mix(col, col * nurFarbe(uShallow) * 1.30, flach * 0.55);

    /*
     * RAUSCHEN für Brandung und Strandbreite. Beide Gitter sind gegen die
     * Weltachsen gedreht — ein achsenparalleles Rauschgitter sieht man als
     * Karomuster, daran ist schon der erste Schaum dieses Shaders gescheitert
     * (siehe Sackgasse 1 unten).
     */
    float wellen = rauschenFbm(dreh(vWorld, 0.6) * (1.0 / 165.0)
                 + vec2(0.0290, -0.0165) * zeit + uOffBrandung);
    float streuung = rauschenFbm(dreh(vWorld, 2.1) * (1.0 / 2600.0) + uOffStrand);

    /*
     * SAND UND GRAS, in WELTkoordinaten gekachelt — nicht in Bildschirm-
     * koordinaten, sonst wanderte der Boden beim Scrollen unter der Insel weg.
     *
     * ⚠️ Die Sandkachel hat eine schwache Naht. Eine zweite, gedrehte und
     * deutlich anders skalierte Abtastung derselben Kachel bricht sie auf —
     * derselbe Kunstgriff wie bei den Wasserlagen. Der Kontrastverlust durch das
     * Mischen ist hier ANDERS als beim Wasser unbedenklich: er ist konstant und
     * fällt deshalb niemandem als Zoomstufe auf, in der die Insel flauer aussieht.
     */
    vec2 sandUV = vWorld * (1.0 / KUESTE_KACHEL) + uOffSand;
    vec2 sandUV2 = dreh(vWorld, 2.35) * (1.0 / (KUESTE_KACHEL * 0.61))
                 + vec2(0.37, 0.14) + uOffSand2;
    vec3 sand = mix(texture(uSand, sandUV).rgb, texture(uSand, sandUV2).rgb, 0.45);
    vec3 gras = texture(uGras, dreh(vWorld, -0.4) * (1.0 / KUESTE_KACHEL) + uOffGras).rgb;

    /*
     * STRANDBREITE mit Rauschen. Ohne sie läuft die Bewuchsgrenze exakt
     * parallel zur Küste — daran erkennt man ein Abstandsfeld auf den ersten
     * Blick, und keine Insel der Welt sieht so aus.
     */
    float strandAbstand = kueste + (streuung - 0.5) * 2.0 * KUESTE_STRAND_RAUSCHEN;
    float grasAnteil = 1.0 - smoothstep(
      -(KUESTE_STRAND + KUESTE_GRAS_UEBERGANG), -KUESTE_STRAND, strandAbstand);
    vec3 boden = mix(sand, gras, grasAnteil);

    // NASSER SAND: der dunkle Saum, den die auflaufende See hinterlässt.
    float nass = smoothstep(-KUESTE_NASS, -KUESTE_NASS * 0.08, kueste);
    boden *= mix(1.0, KUESTE_NASS_DUNKEL, nass) * KUESTE_BODEN_HELL;

    /*
     * Das Land bekommt DASSELBE Licht wie das Wasser, dazu einen milden
     * gerichteten Anteil aus der Sonnenhöhe. Bewusst kein Glanz: Sand und
     * Bewuchs sind matt, ein Streiflicht wie auf den Wellenkämmen sähe aus wie
     * nasser Fels.
     */
    vec3 landCol = boden * licht * (0.80 + 0.40 * uSunStrength * sonnenhoehe) + umgebung;

    /*
     * WASSERLINIE. Bewusst weich: bei 14,6 m Feldauflösung wäre eine harte
     * Kante eine sichtbare Treppe, und die Brandung deckt den Saum ohnehin ab.
     */
    float landMaske = 1.0 - smoothstep(
      -KUESTE_WASSERLINIE * 0.5, KUESTE_WASSERLINIE * 0.5, kueste);
    col = mix(col, landCol, landMaske);

    /*
     * BRANDUNG ZULETZT — sie läuft über die Wasserlinie hinaus auf den nassen
     * Sand, muss also über dem Land liegen. Das Rauschen verschiebt das Band
     * gegen die Küste, sonst liegt es als gleichmäßiger Reif um die Insel.
     */
    float brandungAbstand = kueste + (wellen - 0.5) * 26.0;
    float brandung =
      (1.0 - smoothstep(KUESTE_BRANDUNG_SEE * 0.35, KUESTE_BRANDUNG_SEE, brandungAbstand))
      * smoothstep(KUESTE_BRANDUNG_LAND, KUESTE_BRANDUNG_LAND + 9.0, brandungAbstand);
    col = mix(col, licht * 0.90, brandung * 0.85);
  }

  // Belichtung ganz zuletzt: sie hebt alles gemeinsam an und lässt die
  // Verhältnisse untereinander unberührt — sonst wäre eine Nachtszene
  // physikalisch korrekt und trotzdem unbrauchbar.
  finalColor = vec4(col * uExposure, 1.0);
}
`;

/**
 * Die Wasserfläche: ein einziges Rechteck in Weltkoordinaten, das eine
 * kachelnde WASSERAUFNAHME anzeigt und verzerrt.
 *
 * Der Weg dorthin ging über zwei Sackgassen, die beide im Repo dokumentiert
 * sind (siehe auch tools/ocean-texture.py):
 *
 * 1. Rein prozedural — sieben Sinuslagen mit Rauschmodulation. Ergab sichtbare
 *    Diagonalstreifen, und der Schaum kam aus einer Oktave Wertrauschen auf
 *    einem achsenparallelen 50-m-Gitter; man sah das Gitter.
 * 2. Kachel als Höhenfeld — die Vorlage wurde in Graustufen zerlegt, entlichtet
 *    und vom Shader neu beleuchtet. Auf dem Bildschirm stand danach der Shader,
 *    nicht die Vorlage.
 *
 * Jetzt gilt: die Textur IST das Wasser. Der Shader verzerrt sie, spreizt sie
 * nach Seegang und färbt sie nach Wetter — mehr nicht. Die Kosten hängen nur an
 * der Bildschirmfläche, nicht an der Kartengröße; es gibt kein Kachel-Mesh,
 * sondern eine Textur, die in Weltkoordinaten wiederholt abgetastet wird.
 *
 * Das Mesh hängt im `groundLayer`, deshalb stecken Kamera, Zoom und Neigung
 * bereits in Pixis eigenen Matrizen. `vWorld` ist dadurch die echte, ungekippte
 * Weltkoordinate — es gibt kein Kamera-Uniform, das man vergessen könnte.
 */
export class Ocean {
  /**
   * Bewusst `Mesh<Geometry, Shader>` statt des Defaults `Mesh<MeshGeometry,
   * TextureShader>`: die Fläche braucht keine UV-Attribute (die UV ist eine
   * reine Funktion von `vWorld`), und eine MeshGeometry mit ungenutztem `aUV`
   * würde Pixi bei jedem Erstkontakt warnen.
   */
  readonly mesh: Mesh<Geometry, Shader>;

  private readonly geometry: Geometry;
  private readonly shader: Shader;
  private elapsed = 0;
  /** Abstandsfeld der Küste — `null` auf Karten ohne Landmassen. */
  private field: IslandField | null = null;
  /** Wache gegen das Nachreichen der Bodentexturen in einen toten Shader. */
  private destroyed = false;

  constructor(map: GameMap) {
    this.geometry = new Geometry({
      attributes: { aPosition: quadVertices(map) },
      indexBuffer: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });

    this.shader = Shader.from({
      gl: {
        vertex,
        fragment,
        name: 'ocean',
        // Ohne das hier setzt Pixi mediump: bei Weltkoordinaten um 10.000
        // hätte das eine Schrittweite von mehreren Units und die Kachel
        // würde sichtbar einrasten.
        preferredFragmentPrecision: 'highp',
      },
      resources: {
        oceanUniforms: {
          uTime: { value: 0, type: 'f32' },
          uZoom: { value: 1, type: 'f32' },
          uSeaState: { value: WATER.seaState, type: 'f32' },
          // Der Blickwinkel steckt in der Projektion, aber der Glanz braucht
          // ihn als Zahl — sonst stimmt er nicht mehr, sobald jemand die
          // Neigung verstellt.
          uTilt: { value: getTilt(), type: 'f32' },
          uDeep: { value: new Float32Array(WATER.deep), type: 'vec3<f32>' },
          uShallow: { value: new Float32Array(WATER.shallow), type: 'vec3<f32>' },
          uSun: { value: new Float32Array(WATER.sun), type: 'vec3<f32>' },
          uSkyHorizon: { value: new Float32Array(WATER.skyHorizon), type: 'vec3<f32>' },
          uSkyZenith: { value: new Float32Array(WATER.skyZenith), type: 'vec3<f32>' },
          uSunColor: { value: new Float32Array(WATER.sunColor), type: 'vec3<f32>' },
          uSunStrength: { value: 1, type: 'f32' },
          uLightLevel: { value: 1, type: 'f32' },
          uExposure: { value: 1, type: 'f32' },
          uWarpStrength: { value: WATER.warpStrength, type: 'f32' },
          uDrift: { value: WATER.driftSpeed, type: 'f32' },
          uOffWarp: { value: new Float32Array(2), type: 'vec2<f32>' },
          uOffWarp2: { value: new Float32Array(2), type: 'vec2<f32>' },
          uOffWeit: { value: new Float32Array(2), type: 'vec2<f32>' },
          uOffGrob: { value: new Float32Array(2), type: 'vec2<f32>' },
          uOffFein: { value: new Float32Array(2), type: 'vec2<f32>' },
          uOffTiefe: { value: new Float32Array(2), type: 'vec2<f32>' },
          uOffLand: { value: new Float32Array(2), type: 'vec2<f32>' },
          uOffBrandung: { value: new Float32Array(2), type: 'vec2<f32>' },
          uOffStrand: { value: new Float32Array(2), type: 'vec2<f32>' },
          uOffSand: { value: new Float32Array(2), type: 'vec2<f32>' },
          uOffSand2: { value: new Float32Array(2), type: 'vec2<f32>' },
          uOffGras: { value: new Float32Array(2), type: 'vec2<f32>' },
          // Küste: aus bis `setIslands` eine Karte MIT Landmassen bringt.
          uLandAn: { value: 0, type: 'f32' },
          uLandInv: { value: new Float32Array(2), type: 'vec2<f32>' },
          uLandZellen: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
          uLandReichweite: { value: 1, type: 'f32' },
        },
        // Texturen sind in Pixi 8 RESSOURCEN, keine Uniforms: Quelle und
        // Abtaststil gehen getrennt hinein. `loadFxTextures` läuft in
        // Game.init VOR `new World()`, die Kachel ist hier also da; der
        // Weiß-Ersatz greift nur bei fehlgeschlagenem Laden — dann ist das
        // Wasser eine flache Fläche, das Spiel bleibt aber lauffähig.
        uWater: (oceanWaterTexture() ?? Texture.WHITE).source,
        uWaterStyle: (oceanWaterTexture() ?? Texture.WHITE).source.style,
        /*
         * Küstentexturen als Platzhalter. Sie entstehen erst beim Kartenladen
         * (Abstandsfeld) bzw. werden dann erst geholt (Boden) — der Ozean
         * dagegen existiert schon, bevor die erste Karte da ist.
         *
         * Das Nachreichen ist in Pixi 8 vorgesehen: `shader.resources.uLand = …`
         * tauscht den Eintrag in der Bindegruppe, und die Bindefunktion liest
         * ihn bei JEDEM Zeichnen neu. Nur die Zuordnung Name -> Texturplatz
         * steht fest, und die ändert sich dabei nicht.
         */
        uLand: Texture.WHITE.source,
        uLandStyle: Texture.WHITE.source.style,
        uSand: Texture.WHITE.source,
        uSandStyle: Texture.WHITE.source.style,
        uGras: Texture.WHITE.source,
        uGrasStyle: Texture.WHITE.source.style,
      },
    });

    this.mesh = new Mesh({ geometry: this.geometry, shader: this.shader });
    // Deckende Fläche, die als Erstes gezeichnet wird — Blending spart Füllrate.
    this.mesh.blendMode = 'none';
  }

  /** Passt die Fläche an eine neue Kartengröße an, ohne neu zu allozieren. */
  resizeTo(map: GameMap): void {
    const buffer = this.geometry.getBuffer('aPosition');
    (buffer.data as Float32Array).set(quadVertices(map));
    buffer.update();
  }

  /**
   * Landmassen der Karte übernehmen: Abstandsfeld bauen und den Küstenblock
   * scharfschalten. Karten ohne Inseln (ocean01) legen ihn still — dort läuft
   * anschließend kein einziger Küstenschritt.
   *
   * Der Bau blockiert für ein paar hundert Millisekunden. Das ist Absicht: er
   * läuft im Ladebildschirm, und ein halb aufgebautes Küstenfeld wäre schlimmer
   * als ein etwas längerer Balken.
   */
  setIslands(map: GameMap): void {
    const uniforms = this.shader.resources['oceanUniforms'].uniforms;

    /*
     * ⚠️ Die Bodenkacheln VOR dem Bau anfordern, nicht danach. Der Bau blockiert
     * den Hauptthread eine halbe Sekunde; der Netzabruf läuft daneben weiter und
     * ist hinterher meist schon da. Fordert man sie erst nach dem Bau an, beginnt
     * die Leitung erst zu arbeiten, wenn der Ladebalken durch ist — und die Insel
     * erscheint erst ein paar Bilder nach dem Spawn (bis dahin steht dort Wasser,
     * denn scharf geschaltet wird erst mit dem Boden, siehe unten).
     *
     * `buildIslandField` gibt genau dann `null` zurück, wenn die Karte keine
     * Umrisse trägt — dieselbe Bedingung, also holt ocean01 die Kacheln weiterhin
     * nicht.
     */
    const bodenLauf = (map.islands?.length ?? 0) > 0 ? loadTerrainTextures() : null;

    const vorheriges = this.field;
    this.field = buildIslandField(map);

    // Zurück auf null: ein Rebase-Ausgleich der VORIGEN Karte würde die Küste
    // sonst um eine Kartenlänge daneben zeichnen.
    (uniforms.uOffLand as Float32Array).set([0, 0]);
    uniforms.uLandAn = 0;

    const feld = this.field;
    /*
     * ⚠️ ERST umhängen, DANN das alte Feld freigeben — nie umgekehrt.
     * `TextureSource.destroy` meldet ein "change", und die Bindegruppe wirft
     * daraufhin ihren GESAMTEN Inhalt weg (BindGroup.onResourceChange prüft
     * `resource.destroyed`). Eine zerstörte Quelle, die noch eingehängt ist,
     * reißt also nicht nur sich selbst mit, sondern auch das Wasser und
     * sämtliche Uniforms des Ozeans.
     */
    const landQuelle = feld ? feld.texture.source : Texture.WHITE.source;
    this.shader.resources['uLand'] = landQuelle;
    this.shader.resources['uLandStyle'] = landQuelle.style;
    vorheriges?.texture.destroy(true);

    if (!feld) return;

    (uniforms.uLandInv as Float32Array).set([1 / map.width, 1 / map.height]);
    (uniforms.uLandZellen as Float32Array).set([feld.breite, feld.hoehe]);
    uniforms.uLandReichweite = feld.reichweite;

    /*
     * Scharf geschaltet wird erst, wenn auch der Boden da ist. Sonst stünde für
     * die paar Bilder bis zum Eintreffen der Kacheln eine kreideweiße Insel im
     * Wasser — sichtbar genau in dem Moment, in dem der Ladebildschirm geht.
     * Schlägt das Laden fehl, wird trotzdem eingeschaltet: eine weiße Insel ist
     * immer noch besser als eine unsichtbare.
     */
    void (bodenLauf ?? loadTerrainTextures()).then((boden) => {
      if (this.destroyed || this.field !== feld) return;
      if (boden) {
        this.shader.resources['uSand'] = boden.sand.source;
        this.shader.resources['uSandStyle'] = boden.sand.source.style;
        this.shader.resources['uGras'] = boden.gras.source;
        this.shader.resources['uGrasStyle'] = boden.gras.source.style;
      }
      uniforms.uLandAn = 1;
    });
  }

  /**
   * ENDLOS-KARTE: der Client hat alle Weltkoordinaten um (dx, dy) verschoben
   * (Rebase nach einer Kartenrunde). Jede Abtastlage bekommt den exakten
   * UV-Ausgleich — Drehwinkel und Maßstäbe MÜSSEN zu den Konstanten im
   * Fragment-Shader passen. Damit ist das Wasserbild im Rebase-Frame
   * identisch, der Spieler sieht nichts.
   */
  applyRebase(dx: number, dy: number): void {
    const uniforms = this.shader.resources['oceanUniforms'].uniforms;
    const lagen: Array<{ ziel: string; winkel: number; inv: number }> = [
      { ziel: 'uOffWarp', winkel: 0, inv: 1 / 430 },
      { ziel: 'uOffWarp2', winkel: 0.9, inv: 1 / 233 },
      { ziel: 'uOffWeit', winkel: -0.55, inv: 1 / 940 },
      { ziel: 'uOffGrob', winkel: 0, inv: 1 / 255 },
      { ziel: 'uOffFein', winkel: 1.05, inv: 1 / 61 },
      { ziel: 'uOffTiefe', winkel: 0, inv: 1 / 5200 },
      // Küste: Rauschlagen und Bodenkacheln. Ohne diese vier Zeilen SPRÄNGE
      // der Strand beim Nahtwechsel — die Kachelgröße (520 m) ist kein Teiler
      // der Kartenlänge, eine Kartenlänge weiter läge also ein anderer Ausschnitt
      // der Kachel unter derselben Küste.
      { ziel: 'uOffBrandung', winkel: 0.6, inv: 1 / 165 },
      { ziel: 'uOffStrand', winkel: 2.1, inv: 1 / 2600 },
      { ziel: 'uOffSand', winkel: 0, inv: 1 / 520 },
      { ziel: 'uOffSand2', winkel: 2.35, inv: 1 / (520 * 0.61) },
      { ziel: 'uOffGras', winkel: -0.4, inv: 1 / 520 },
    ];
    for (const lage of lagen) {
      const c = Math.cos(lage.winkel);
      const s = Math.sin(lage.winkel);
      const offset = uniforms[lage.ziel] as Float32Array;
      // uv = dreh(world)·inv + off. world wandert um (dx, dy) — der Ausgleich
      // ist das Negative der gedrehten, skalierten Verschiebung.
      offset[0] = (offset[0] ?? 0) - (dx * c - dy * s) * lage.inv;
      offset[1] = (offset[1] ?? 0) - (dx * s + dy * c) * lage.inv;
    }

    /*
     * Das Abstandsfeld deckt GENAU eine Karte ab und wiederholt sich; ein
     * Rebase ist damit exakt eine UV-Einheit, und die Küste stünde auch ohne
     * Ausgleich richtig. Der Ausgleich hält die abgetastete Koordinate trotzdem
     * nahe bei null — dort ist die Auflösung der Gleitkommazahl am größten, und
     * die Zellsuche in `landAbstand` rechnet mit dem Zweitausendfachen davon.
     * Eigene Skalierung je Achse, weil das Feld nicht quadratisch sein muss.
     */
    const landInv = uniforms.uLandInv as Float32Array;
    const landOff = uniforms.uOffLand as Float32Array;
    landOff[0] = (landOff[0] ?? 0) - dx * (landInv[0] ?? 0);
    landOff[1] = (landOff[1] ?? 0) - dy * (landInv[1] ?? 0);
  }

  /** Seegang von 0 (spiegelglatt) bis 1. Kommt vom Server (Karten-Wetter). */
  setSeaState(value: number): void {
    this.shader.resources['oceanUniforms'].uniforms.uSeaState = Math.min(Math.max(value, 0), 1);
  }

  /**
   * Sonnenstand, Himmelsfarben und Helligkeit setzen.
   *
   * Die WERTE kommen aus `atmosphereFor` in shared — hier landen sie nur in
   * den Uniforms. Die Farben werden in vorhandene Float32Arrays geschrieben
   * statt neu angelegt: das läuft potenziell jeden Frame (Tag/Nacht-Uhr).
   */
  setAtmosphere(atmosphere: Atmosphere): void {
    const uniforms = this.shader.resources['oceanUniforms'].uniforms;
    (uniforms.uSun as Float32Array).set(atmosphere.sunDirection);
    (uniforms.uSunColor as Float32Array).set(atmosphere.sunColor);
    (uniforms.uSkyHorizon as Float32Array).set(atmosphere.skyHorizon);
    (uniforms.uSkyZenith as Float32Array).set(atmosphere.skyZenith);
    uniforms.uSunStrength = atmosphere.sunStrength;
    uniforms.uLightLevel = atmosphere.lightLevel;
    uniforms.uExposure = atmosphere.exposure;
  }

  update(deltaSeconds: number, zoom: number): void {
    this.elapsed += deltaSeconds;
    const uniforms = this.shader.resources['oceanUniforms'].uniforms;
    uniforms.uTime = this.elapsed;
    uniforms.uZoom = zoom;
    uniforms.uTilt = getTilt();
  }

  destroy(): void {
    this.destroyed = true;
    this.mesh.removeFromParent();
    this.mesh.destroy();
    // Geometry und Shader hängen NICHT an den DestroyOptions des Containers —
    // ohne diese beiden Zeilen bleiben Buffer und Programm auf der GPU liegen.
    this.geometry.destroy(true);
    this.shader.destroy(true);
    /*
     * Das Abstandsfeld gehört dem Ozean: es ist zur Laufzeit gebaut und hängt an
     * keinem Asset-Cache, der es sonst abräumen würde. ZULETZT freigeben, erst
     * nach dem Shader — siehe die Warnung in `setIslands`.
     */
    this.field?.texture.destroy(true);
    this.field = null;
  }
}

function quadVertices(map: GameMap): Float32Array {
  // ENDLOS-KARTE: die Fläche reicht eine halbe Kartenlänge über jede Naht
  // hinaus. Die Kamera pendelt (durch den Rebase) in [−0,25·Kante, 1,25·Kante]
  // — mit diesem Rand sieht man nie eine Wasserkante, und die Kosten hängen
  // ohnehin nur an der Bildschirmfläche, nicht an der Quad-Größe.
  const rx = map.width * 0.5;
  const ry = map.height * 0.5;
  return new Float32Array([
    -rx, -ry,
    map.width + rx, -ry,
    map.width + rx, map.height + ry,
    -rx, map.height + ry,
  ]);
}
