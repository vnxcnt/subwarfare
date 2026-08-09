import type { GameMap } from '@subwarfare/shared';
import { Geometry, Mesh, Shader } from 'pixi.js';
import { WATER } from '../config';

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
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSun;

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

// Eine Wellenlage. Wellenlänge und Amplitude stehen in Weltunits (~Meter),
// damit die Zahlen lesbar und plausibel bleiben.
// Rückgabe: .x = Auslenkung, .yz = analytischer Gradient (kein Sampling nötig).
vec3 waveLayer(vec2 world, vec2 dir, float wavelength, float speed, float amp) {
  vec2 d = normalize(dir);
  float k = TAU / wavelength;
  float phase = dot(world, d) * k + uTime * speed;
  return vec3(amp * sin(phase), amp * k * cos(phase) * d);
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
  vec3 swell = waveLayer(vWorld, vec2(0.9, 0.45), 900.0, 0.26, 30.0 * layerFade(900.0));

  // Domain-Warp nur für die Windwellen; die Dünung soll ruhig durchlaufen.
  vec2 q = vWorld + (valueNoise(vWorld * 0.0025 + uTime * 0.02) - 0.5) * 40.0;

  // Geschwindigkeiten sind die Tiefwasser-Kreisfrequenzen sqrt(g * k) —
  // dadurch bewegen sich lange und kurze Wellen im richtigen Verhältnis.
  float s = uSeaState;
  float a1 = 6.00 * s * layerFade(140.0);
  float a2 = 2.60 * s * layerFade(70.0);
  float a3 = 1.10 * s * layerFade(34.0);
  float a4 = 0.45 * s * layerFade(17.0);
  float a5 = 0.18 * s * layerFade(8.0);

  vec3 chop = waveLayer(q, vec2( 1.0,  0.35), 140.0, 0.66, a1)
            + waveLayer(q, vec2(-0.6,  1.00),  70.0, 0.94, a2)
            + waveLayer(q, vec2( 0.8, -0.90),  34.0, 1.35, a3)
            + waveLayer(q, vec2(-1.0, -0.25),  17.0, 1.90, a4)
            + waveLayer(q, vec2( 0.4,  1.00),   8.0, 2.77, a5);

  // z groß halten: sanfte Normalen. Kleine Werte lassen die Fläche wie
  // Wellblech aussehen statt wie Wasser.
  vec3 grad = swell + chop;
  vec3 n = normalize(vec3(-grad.y, -grad.z, 2.5));
  vec3 sun = normalize(uSun);
  vec3 halfway = normalize(sun + vec3(0.0, 0.0, 1.0));

  // Tiefenzonen: zwei große Oktaven, damit die Übersicht Struktur hat.
  float depth = valueNoise(vWorld * 0.00028) * 0.65 + valueNoise(vWorld * 0.00075) * 0.35;
  vec3 base = mix(uShallow, uDeep, smoothstep(0.2, 0.8, depth));

  // Auf die aktiven Amplituden normiert, sonst wandert die Schaumgrenze mit
  // jeder ausgeblendeten Lage. Zusätzlich mit einem Rauschfeld maskiert: reine
  // Sinuslagen erreichen ihr Maximum auf einem regelmäßigen Gitter, sonst
  // liegen die Kämme als sichtbares Punktraster auf dem Wasser.
  float ampSum = a1 + a2 + a3 + a4 + a5;
  float patchiness = valueNoise(q * 0.02 + uTime * 0.05);
  float crest = smoothstep(0.80, 0.99, chop.x / max(ampSum, 0.001))
              * smoothstep(0.45, 0.80, patchiness);

  float spec = pow(max(dot(n, halfway), 0.0), 140.0);

  vec3 col = base * (0.70 + 0.30 * max(dot(n, sun), 0.0))
           + vec3(0.60, 0.78, 0.92) * spec * 0.30
           + vec3(0.70, 0.85, 0.95) * crest * 0.12;

  finalColor = vec4(col, 1.0);
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
          uDeep: { value: new Float32Array(WATER.deep), type: 'vec3<f32>' },
          uShallow: { value: new Float32Array(WATER.shallow), type: 'vec3<f32>' },
          uSun: { value: new Float32Array(WATER.sun), type: 'vec3<f32>' },
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

  /** Seegang von 0 (spiegelglatt) bis 1. Später vom Server steuerbar. */
  setSeaState(value: number): void {
    this.shader.resources['oceanUniforms'].uniforms.uSeaState = Math.min(Math.max(value, 0), 1);
  }

  update(deltaSeconds: number, zoom: number): void {
    this.elapsed += deltaSeconds;
    const uniforms = this.shader.resources['oceanUniforms'].uniforms;
    uniforms.uTime = this.elapsed;
    uniforms.uZoom = zoom;
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
