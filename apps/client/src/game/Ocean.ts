import type { Atmosphere, GameMap } from '@subwarfare/shared';
import { Geometry, Mesh, Shader, Texture } from 'pixi.js';
import { WATER } from '../config';
import { oceanWaterTexture } from './fx-textures';
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

/**
 * Die Wasseroberfläche als FARBIGE Kachel — eine echte Wasseraufnahme, von
 * tools/ocean-texture.py nahtlos gemacht. Sie wird ANGEZEIGT, nicht
 * nachgerechnet: Wellen, Kämme und Schaum stecken bereits darin.
 */
uniform sampler2D uWater;

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

void main() {
  float see = uSeaState;

  /*
   * VERZERRUNG. Dieselbe Kachel, sehr grob abgetastet und langsam wandernd,
   * verschiebt die Abtastkoordinate der sichtbaren Lagen. Das ist derselbe
   * Kunstgriff wie ein Displacement-Filter: das Bild bleibt das Bild, es
   * atmet nur. Ohne diesen Schritt sähe die Fläche aus wie ein gemustertes
   * Tuch, das über den Bildschirm geschoben wird.
   */
  vec2 warpUV = vWorld * (1.0 / 430.0) + vec2(0.0042, -0.0029) * uTime;
  vec2 warp = (texture(uWater, warpUV).rg - 0.5) * (34.0 * (0.30 + 0.70 * see));

  /*
   * ZWEI MASSSTÄBE derselben Kachel, gegeneinander verdreht und
   * unterschiedlich schnell driftend. Ein einzelner Maßstab wäre als Raster
   * erkennbar; das krumme Größenverhältnis (255 : 61) verhindert, dass die
   * beiden Raster periodisch zusammenfallen.
   */
  vec2 pWeit = dreh(vWorld + warp * 1.4, -0.55) * (1.0 / 940.0)
             + vec2(0.0004, 0.0003) * uTime;
  vec2 pGrob = (vWorld + warp) * (1.0 / 255.0) + vec2(0.0011, 0.0008) * uTime;
  vec2 pFein = dreh(vWorld + warp * 0.55, 1.05) * (1.0 / 61.0)
             + vec2(-0.0034, 0.0023) * uTime;

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
  vec3 kachelMittel = vec3(0.127, 0.175, 0.211);
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
  float tiefe = smoothstep(0.25, 0.75, texture(uWater, vWorld * (1.0 / 5200.0) + vec2(0.11, 0.37)).b);
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
  vec3 col = wasser * mix(vec3(1.0), tint, 0.28)
           * pow(max(uLightLevel, 0.001), 0.8)
           * (0.72 + 0.38 * uSunStrength)
           * 1.15;

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
  col += mix(uSkyZenith, uSkyHorizon, 0.5) * 0.07;

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
        },
        // Texturen sind in Pixi 8 RESSOURCEN, keine Uniforms: Quelle und
        // Abtaststil gehen getrennt hinein. `loadFxTextures` läuft in
        // Game.init VOR `new World()`, die Kachel ist hier also da; der
        // Weiß-Ersatz greift nur bei fehlgeschlagenem Laden — dann ist das
        // Wasser eine flache Fläche, das Spiel bleibt aber lauffähig.
        uWater: (oceanWaterTexture() ?? Texture.WHITE).source,
        uWaterStyle: (oceanWaterTexture() ?? Texture.WHITE).source.style,
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
    this.mesh.removeFromParent();
    this.mesh.destroy();
    // Geometry und Shader hängen NICHT an den DestroyOptions des Containers —
    // ohne diese beiden Zeilen bleiben Buffer und Programm auf der GPU liegen.
    this.geometry.destroy(true);
    this.shader.destroy(true);
  }
}

function quadVertices(map: GameMap): Float32Array {
  return new Float32Array([0, 0, map.width, 0, map.width, map.height, 0, map.height]);
}
