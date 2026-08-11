import type { Atmosphere, GameMap } from '@subwarfare/shared';
import { Geometry, Mesh, Shader } from 'pixi.js';
import { WATER } from '../config';
import { getTilt } from './Projection';

/*
 * Hinweis zum GLSL-Dialekt: Ohne `#version 300 es` im FRAGMENT bleibt Pixi im
 * GLSL-ES-1.00-Pfad und injiziert die Kompatibilitäts-Defines
 * (`in` -> attribute/varying, `finalColor` -> gl_FragColor). Das ist der
 * robuste Weg, der auch auf einem WebGL1-Fallback compiliert.
 * `out vec4 finalColor;` muss dabei zeichengenau so geschrieben sein — Pixi
 * entfernt exakt diese Zeichenfolge per String-Replace.
 */

const vertex = `
in vec2 aPosition;
out vec2 vWorld;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

void main() {
  vWorld = aPosition;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}
`;

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

const float TAU = 6.2831853;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}

/*
 * Eine Wellenlage. Wellenlänge und Amplitude stehen in Weltunits (~Meter),
 * damit die Zahlen lesbar und plausibel bleiben.
 * Rückgabe: .x = Auslenkung, .yz = analytischer Gradient (kein Sampling nötig).
 *
 * Zwei Kunstgriffe gegen den „Wellblech"-Eindruck reiner Sinuslagen:
 *
 * 1. SCHÄRFUNG: echte Wellen sind trochoidal — spitze Kämme, flache Täler.
 *    Statt sin(p) nutzen wir eine hochgezogene Variante; die Ableitung wird
 *    analytisch mitgeführt, damit die Normalen exakt bleiben.
 * 2. FLECKIGKEIT: die Amplitude wird mit einem langsam driftenden Rauschfeld
 *    moduliert. Ohne das treffen sich die Maxima aller Lagen auf einem
 *    regelmäßigen Gitter, und das Wasser bekommt ein sichtbares Karomuster.
 */
vec3 waveLayer(vec2 world, vec2 dir, float wavelength, float speed, float amp, float seed) {
  vec2 d = normalize(dir);
  float k = TAU / wavelength;
  float phase = dot(world, d) * k + uTime * speed;

  // Amplitudenfleckigkeit: grob dreimal die Wellenlänge, langsam wandernd.
  float mod1 = valueNoise(world / (wavelength * 3.0) + vec2(seed, seed * 1.7) + uTime * 0.01);
  float a = amp * (0.45 + 1.1 * mod1);

  float s = sin(phase);
  // Schärfung: (s+1)/2 hoch 1.6, zurück auf [-1,1]. Der Faktor unten ist die
  // Kettenregel dieser Abbildung.
  float t = (s + 1.0) * 0.5;
  float sharp = pow(t, 1.6) * 2.0 - 1.0;
  float dsharp = 1.6 * pow(max(t, 0.0001), 0.6) * cos(phase);

  return vec3(a * sharp, a * k * dsharp * d);
}

// Blendet eine Lage aus, sobald ein Wellenzug auf zu wenige Bildschirmpixel
// fällt. Ohne das entsteht beim Rauszoomen ein regelmäßiges Moiré-Gewebe
// statt Wasser — die Wellenlänge landet dann genau im Aliasing-Bereich.
float layerFade(float wavelength) {
  return smoothstep(14.0, 45.0, wavelength * uZoom);
}

void main() {
  // Dünung, rund 900 m. Trägt die Schattierung, wenn in der Übersicht alle
  // feineren Lagen weggeblendet sind.
  vec3 swell = waveLayer(vWorld, vec2(0.9, 0.45), 900.0, 0.26, 30.0 * layerFade(900.0), 3.1);

  // Domain-Warp nur für die Windwellen; die Dünung soll ruhig durchlaufen.
  vec2 q = vWorld + (valueNoise(vWorld * 0.0025 + uTime * 0.02) - 0.5) * 40.0;

  /*
   * Windsee aus sieben Lagen. Bewusst KRUMME Wellenlängen und ein breiter
   * Richtungsfächer: harmonische Verhältnisse (140/70/35) wiederholen sich
   * nach kurzer Strecke sichtbar, ein eng gebündelter Fächer erzeugt lange
   * gerade Streifen quer übers Bild. Die Geschwindigkeiten sind die
   * Tiefwasser-Kreisfrequenzen sqrt(g·k) — lange und kurze Wellen bewegen sich
   * dadurch im richtigen Verhältnis zueinander.
   */
  float s = uSeaState;
  float a1 = 5.20 * s * layerFade(155.0);
  float a2 = 2.90 * s * layerFade(83.0);
  float a3 = 1.60 * s * layerFade(47.0);
  float a4 = 0.90 * s * layerFade(29.0);
  float a5 = 0.50 * s * layerFade(16.0);
  float a6 = 0.26 * s * layerFade(9.0);
  float a7 = 0.13 * s * layerFade(5.0);

  /*
   * Zweiter, feinerer Domain-Warp NUR für die kurzen Lagen: sie sollen
   * mäandern statt schnurgerade durchzulaufen.
   */
  vec2 qk = q + (valueNoise(q * 0.03 - uTime * 0.06) - 0.5) * 9.0;

  /*
   * Richtungsfächer: die LANGEN Lagen dürfen weit auseinanderlaufen (Dünung
   * aus mehreren Wettergebieten), die KURZEN laufen fast parallel zum Wind.
   * Genau umgekehrt entsteht sonst ein Karomuster — kurze Wellen quer
   * zueinander kreuzen sich sichtbar zu einem Gitter, und der Nahzoom sieht
   * aus wie ein Drahtnetz statt wie Wasser.
   */
  vec3 chop = waveLayer(q,  vec2( 1.00,  0.32), 155.0, 0.63, a1, 0.7)
            + waveLayer(q,  vec2(-0.52,  1.00),  83.0, 0.86, a2, 1.9)
            + waveLayer(q,  vec2( 0.86, -0.74),  47.0, 1.14, a3, 2.6)
            + waveLayer(q,  vec2( 0.72,  0.62),  29.0, 1.45, a4, 4.3)
            + waveLayer(qk, vec2( 0.96,  0.44),  16.0, 1.96, a5, 5.8)
            + waveLayer(qk, vec2( 1.00,  0.16),   9.0, 2.61, a6, 7.2)
            + waveLayer(qk, vec2( 0.88,  0.52),   5.0, 3.50, a7, 8.9);

  // z groß halten: sanfte Normalen. Kleine Werte lassen die Fläche wie
  // Wellblech aussehen statt wie Wasser.
  vec3 grad = swell + chop;
  vec3 n = normalize(vec3(-grad.y, -grad.z, 2.5));
  vec3 sun = normalize(uSun);

  /*
   * Blickrichtung. Die Karte ist eine gekippte Parallelprojektion: der
   * Höhenwinkel ist asin(uTilt) (~25°), und geblickt wird aus Richtung Norden
   * (Welt-y wächst nach Süden). Weil die Projektion parallel ist, gilt DERSELBE
   * Blickvektor für jeden Punkt der Fläche — genau das macht die folgende
   * Optik so billig.
   */
  float cosEl = sqrt(max(1.0 - uTilt * uTilt, 0.0));
  vec3 view = normalize(vec3(0.0, -cosEl, uTilt));

  /*
   * FRESNEL — der Grund, warum echtes Wasser nicht wie eingefärbtes Plastik
   * aussieht: senkrecht von oben reflektiert es nur ~2 %, im flachen Winkel
   * dagegen fast alles. Bei unserem 25°-Blick liegt der Anteil um 10-20 %, und
   * jede Welle, die sich der Kamera zuneigt, kippt ihn sichtbar. Diese
   * Wanderung zwischen „dunkles Wasser" und „heller Himmel" IST die
   * Wasseranmutung.
   */
  float cosView = clamp(dot(n, view), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosView, 5.0);

  /*
   * Gespiegelter Himmel. Der reflektierte Strahl zeigt bei ruhiger Fläche
   * flach zum Horizont, auf geneigten Wellenflanken steiler nach oben — also
   * mischen wir Horizontdunst und Zenitblau über seine Höhe. Das ersetzt eine
   * echte Reflexion vollständig, solange über dem Wasser nichts steht.
   */
  vec3 refl = reflect(-view, n);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, smoothstep(0.0, 0.75, refl.z));

  // Tiefenzonen: zwei große Oktaven, damit die Übersicht Struktur hat.
  float depth = valueNoise(vWorld * 0.00028) * 0.65 + valueNoise(vWorld * 0.00075) * 0.35;
  vec3 body = mix(uShallow, uDeep, smoothstep(0.2, 0.8, depth));

  /*
   * Rückstreuung aus dem Wasserkörper, verstärkt an den Wellenflanken, die
   * sich von der Sonne wegneigen: dort scheint Licht DURCH den Wellenkamm und
   * lässt ihn türkis aufleuchten. Ohne diesen Anteil wirkt jede Welle wie ein
   * gefärbter Blechbuckel.
   */
  float lift = clamp(grad.x / 12.0, -1.0, 1.0);
  float sss = smoothstep(0.25, 1.0, lift) * (0.3 + 0.7 * max(-dot(n, sun), 0.0));
  // Die gerichtete Aufhellung hängt an der Sonnenstärke: unter geschlossener
  // Wolkendecke gibt es keine Sonnenseite mehr, nur noch flaches Licht.
  vec3 water = body * (0.6 + 0.4 * max(dot(n, sun), 0.0) * uSunStrength)
             + vec3(0.02, 0.11, 0.15) * sss * 0.5 * uSunStrength;
  water *= uLightLevel;

  /*
   * GLITZERPFAD statt Plastik-Glanzpunkt. Eine einzelne enge Keule (früher
   * pow 140) sieht aus wie eine Lackkugel; echtes Sonnenlicht auf See ist ein
   * breiter, unruhiger Pfad aus tausenden Einzelreflexen. Deshalb zwei Keulen:
   * eine breite für den Pfad, eine harte fürs Funkeln — die harte zusätzlich
   * mit feinem Rauschen aufgebrochen, damit sie körnig bleibt.
   */
  vec3 halfway = normalize(sun + view);
  float ndh = max(dot(n, halfway), 0.0);
  // Zwei unabhängige Rauschfelder verschiedener Feinheit — ein einzelnes
  // erzeugt sichtbar gleich große, gleich verteilte Tupfen.
  float glitterMask = valueNoise(vWorld * 0.9 + uTime * 0.8)
                    * valueNoise(vWorld * 0.21 - uTime * 0.35);
  float broad = pow(ndh, 26.0) * 0.5;
  float sparkle = pow(ndh, 220.0) * smoothstep(0.22, 0.55, glitterMask) * 1.6;
  // Nur dort funkeln, wo die Auflösung es hergibt — beim Rauszoomen würde das
  // Funkeln sonst zu einem flimmernden Rauschteppich.
  // Ohne Sonne kein Glitzerpfad — bei Bewölkung verschwindet er als Erstes.
  vec3 glitter =
    uSunColor * (broad + sparkle * smoothstep(0.25, 0.8, uZoom)) * fresnel * 3.0 * uSunStrength;

  /*
   * Schaum. Auf die aktiven Amplituden normiert, sonst wandert die Grenze mit
   * jeder ausgeblendeten Lage; mit einem Rauschfeld maskiert, weil reine
   * Sinuslagen ihr Maximum auf einem regelmäßigen Gitter erreichen und der
   * Schaum sonst als Punktraster erscheint. Zwei Stufen: heller Kamm und ein
   * breiterer, schwacher Saum, der ihn ausfransen lässt.
   */
  float ampSum = a1 + a2 + a3 + a4 + a5 + a6 + a7;
  float rel = chop.x / max(ampSum, 0.001);
  // ACHTUNG beim Umbenennen: "patch" ist in GLSL ES 3.00 ein RESERVIERTES Wort
  // (Tessellation) — auf dem WebGL2-Pfad scheitert die Kompilierung daran.
  // (Und keine Backticks in diesem Shader: er lebt in einem Template-Literal.)
  float patchiness = valueNoise(q * 0.02 + uTime * 0.05);
  float fleck = smoothstep(0.35, 0.80, patchiness);
  float crest = smoothstep(0.72, 0.98, rel) * fleck;
  float wash = smoothstep(0.48, 0.90, rel) * fleck * 0.45;
  /*
   * Aufbrechen des Schaums. Ohne diesen Schritt liegt er als geschlossene
   * weiße Insel auf dem Kamm und sieht aus wie eine Eisscholle; Gischt ist
   * aber löchrig und ausgefranst. Zwei Rauschlagen unterschiedlicher Feinheit
   * fressen Löcher hinein, die feinere driftet schneller.
   */
  float shred = valueNoise(q * 0.25 + uTime * 0.35) * 0.65
              + valueNoise(q * 0.8 - uTime * 0.6) * 0.35;
  /*
   * Die Zerfaserung arbeitet auf 1–4 m — beim Rauszoomen liegt das unter einem
   * Pixel und alisiert zu einem Punktraster (in der Übersicht sah die See aus
   * wie gepunktetes Papier). Deshalb blendet die Detailstufe mit dem Zoom auf
   * „geschlossen" zurück, und der Schaum selbst verschwindet in der weiten
   * Übersicht ganz: einzelne Schaumkronen sind dort ohnehin unsichtbar klein.
   */
  float detail = smoothstep(0.25, 0.9, uZoom);
  float shredded = mix(1.0, smoothstep(0.18, 0.62, shred), detail);
  float foam = clamp(crest + wash, 0.0, 1.0) * uSeaState
             * shredded
             * smoothstep(0.30, 0.75, uZoom);

  // Schaum ist eine STREUENDE Schicht: er liegt auf dem Wasser statt es
  // einzufärben, wird also über alles andere geblendet — und er ist nie ganz
  // deckend, sonst wirkt er wie aufgemalt.
  // Schaum ist weiß und streut — er folgt der allgemeinen Helligkeit, nicht
  // der Sonnenrichtung allein. Nachts bleibt er der hellste Teil des Bildes.
  vec3 foamColor = mix(vec3(0.66, 0.74, 0.80), vec3(0.93, 0.97, 1.0), crest)
                 * (0.6 + 0.4 * max(dot(n, sun), 0.0) * uSunStrength)
                 * (0.35 + 0.65 * uLightLevel);

  /*
   * Zusätzlich zum gespiegelten Himmel bekommt die Fläche diffuses HIMMELSLICHT
   * aus der ganzen Halbkugel — ohne diesen Anteil bleibt Wasser abseits von
   * Sonnenpfad und Spiegelung schwarz und wirkt wie Tinte statt wie See.
   */
  vec3 ambient = mix(uSkyZenith, uSkyHorizon, 0.5) * 0.09;

  vec3 col = mix(water + ambient, sky, fresnel) + glitter;
  col = mix(col, foamColor, foam * 0.7);

  // Belichtung ganz zuletzt: sie hebt alles gemeinsam an und lässt die
  // Verhältnisse untereinander unberührt — sonst wäre eine Nachtszene
  // physikalisch korrekt und trotzdem unbrauchbar.
  finalColor = vec4(col * uExposure, 1.0);
}
`;

/**
 * Die Wasserfläche: ein einziges Rechteck in Weltkoordinaten mit prozeduralem
 * Wellen-Shader. Kein Kachelraster, keine Textur, keine Assets — die Kosten
 * hängen nur an der Bildschirmfläche, nicht an der Kartengröße.
 *
 * Das Mesh hängt im `groundLayer`, deshalb stecken Kamera, Zoom und Neigung
 * bereits in Pixis eigenen Matrizen. `vWorld` ist dadurch die echte, ungekippte
 * Weltkoordinate — es gibt kein Kamera-Uniform, das man vergessen könnte.
 */
export class Ocean {
  /**
   * Bewusst `Mesh<Geometry, Shader>` statt des Defaults `Mesh<MeshGeometry,
   * TextureShader>`: die Fläche braucht weder UVs noch eine Textur, und eine
   * MeshGeometry mit ungenutztem `aUV` würde Pixi bei jedem Erstkontakt warnen.
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
        // hätte das eine Schrittweite von mehreren Units und die Wellen
        // würden sichtbar einrasten.
        preferredFragmentPrecision: 'highp',
      },
      resources: {
        oceanUniforms: {
          uTime: { value: 0, type: 'f32' },
          uZoom: { value: 1, type: 'f32' },
          uSeaState: { value: WATER.seaState, type: 'f32' },
          // Der Blickwinkel steckt in der Projektion, aber Fresnel und
          // Himmelsspiegelung brauchen ihn als Zahl — sonst stimmt die
          // Reflexion nicht mehr, sobald jemand die Neigung verstellt.
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
