import { Geometry, Mesh, Shader, type Texture, type TextureSource } from 'pixi.js';
import type { DirectionFrame } from '../textures';

/*
 * GLSL-Dialekt wie beim Ozean: ohne `#version` bleibt Pixi im 1.00-Pfad und
 * injiziert die Kompatibilitäts-Defines — läuft damit auch auf WebGL1.
 * `out vec4 finalColor;` muss zeichengenau so geschrieben sein.
 */
const vertex = `
in vec2 aPosition;
in vec2 aUV1;
in vec2 aUV2;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out vec2 vUV1;
out vec2 vUV2;

void main() {
  vUV1 = aUV1;
  vUV2 = aUV2;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}
`;

const fragment = `
in vec2 vUV1;
in vec2 vUV2;
out vec4 finalColor;

uniform sampler2D uAtlas;
/** Frame-Rechtecke im Atlas, normalisiert (x, y, w, h). */
uniform vec4 uRect1;
uniform vec4 uRect2;
uniform float uMix;
uniform vec3 uTint;
uniform float uAlpha;

/**
 * Abtasten MIT Rechteck-Wächter: die Eckpunkte des Quads liegen außerhalb
 * des jeweils anderen Frames, und ohne den Wächter kämen dort die Pixel des
 * Nachbarframes aus dem Atlas.
 */
vec4 lese(vec2 uv, vec4 rect) {
  vec2 t = (uv - rect.xy) / rect.zw;
  if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) return vec4(0.0);
  return texture(uAtlas, uv);
}

void main() {
  vec4 a = lese(vUV1, uRect1);
  vec4 b = lese(vUV2, uRect2);
  // ECHTER Crossfade pro Pixel: bei t = 0,5 ist jedes Pixel das Mittel beider
  // Ansichten — kein Halbgeist der oberen über der voll deckenden unteren,
  // und kein Durchscheinen des Wassers wie bei zwei getrennten Sprites.
  vec4 misch = mix(a, b, uMix);
  // Texturen liegen vorge­multipliziert vor: Tint auf RGB, Alpha auf alles.
  finalColor = vec4(misch.rgb * uTint, misch.a) * uAlpha;
}
`;

/**
 * Der Rumpf als EIN Draw aus ZWEI Atlas-Frames.
 *
 * Warum kein Sprite-Paar: Der kontinuierliche Winkel-Blend braucht bei jedem
 * Kurs zwei Nachbar-Ansichten. Zwei übereinandergelegte Sprites können aber
 * nur „B über A" (Halbgeist-Optik aus der Nähe) oder „beide halbtransparent"
 * (das Wasser scheint durchs Schiff). Der Shader mischt die beiden Ansichten
 * PRO PIXEL, bevor überhaupt etwas auf die Szene komponiert wird — das ist
 * der klassische Weg für Billboard-Crossfades, und weil beide Frames im
 * selben Atlas liegen, kostet er genau einen Textur-Bind.
 *
 * Geometrie: ein Quad über der Vereinigungs-BBox beider (gedreht liegender)
 * Frames, in Schiffs-Lokalkoordinaten. Je Ecke werden ZWEI UV-Paare
 * mitgegeben — die Abbildung Schiffsraum → Frame-Pixel ist affin, die
 * Eckwerte interpolieren also exakt.
 */
export class HullBlendMesh extends Mesh<Geometry, Shader> {
  private readonly positionen = new Float32Array(8);
  private readonly uv1 = new Float32Array(8);
  private readonly uv2 = new Float32Array(8);
  private atlasQuelle: TextureSource | null = null;

  constructor(start: Texture) {
    const geometry = new Geometry({
      attributes: {
        aPosition: new Float32Array(8),
        aUV1: new Float32Array(8),
        aUV2: new Float32Array(8),
      },
      indexBuffer: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });

    const shader = Shader.from({
      gl: { vertex, fragment, name: 'hull-blend' },
      resources: {
        hullUniforms: {
          uRect1: { value: new Float32Array(4), type: 'vec4<f32>' },
          uRect2: { value: new Float32Array(4), type: 'vec4<f32>' },
          uMix: { value: 0, type: 'f32' },
          uTint: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uAlpha: { value: 1, type: 'f32' },
        },
        uAtlas: start.source,
        uAtlasStyle: start.source.style,
      },
    });

    super({ geometry, shader });
    this.atlasQuelle = start.source;
  }

  /**
   * Beide Ansichten samt Mischanteil und Tauch-Optik setzen. `rotation*` sind
   * die Restwinkel der jeweiligen Frames (Bildschirmdrehung, Bogenmaß).
   */
  setPair(
    unter: DirectionFrame,
    ueber: DirectionFrame,
    anteil: number,
    rotationUnter: number,
    rotationUeber: number,
    tint: number,
    alpha: number,
  ): void {
    // Modellwechsel: die Frames zeigen auf einen anderen Atlas.
    if (unter.texture.source !== this.atlasQuelle) {
      this.atlasQuelle = unter.texture.source;
      this.shader!.resources['uAtlas'] = unter.texture.source;
      this.shader!.resources['uAtlasStyle'] = unter.texture.source.style;
    }

    // Vereinigungs-BBox beider gedrehter Frames in Schiffs-Lokalkoordinaten.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [frame, rotation] of [
      [unter, rotationUnter],
      [ueber, rotationUeber],
    ] as const) {
      const w = frame.texture.width * frame.metresPerPx;
      const h = frame.texture.height * frame.metresPerPx;
      const c = Math.cos(rotation);
      const s = Math.sin(rotation);
      for (const [ex, ey] of [
        [-frame.anchor.x * w, -frame.anchor.y * h],
        [(1 - frame.anchor.x) * w, -frame.anchor.y * h],
        [(1 - frame.anchor.x) * w, (1 - frame.anchor.y) * h],
        [-frame.anchor.x * w, (1 - frame.anchor.y) * h],
      ]) {
        const x = ex * c - ey * s;
        const y = ex * s + ey * c;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }

    this.positionen.set([minX, minY, maxX, minY, maxX, maxY, minX, maxY]);
    this.schreibeUV(unter, rotationUnter, this.uv1);
    this.schreibeUV(ueber, rotationUeber, this.uv2);

    const geometry = this.geometry;
    (geometry.getBuffer('aPosition').data as Float32Array).set(this.positionen);
    (geometry.getBuffer('aUV1').data as Float32Array).set(this.uv1);
    (geometry.getBuffer('aUV2').data as Float32Array).set(this.uv2);
    geometry.getBuffer('aPosition').update();
    geometry.getBuffer('aUV1').update();
    geometry.getBuffer('aUV2').update();

    const uniforms = this.shader!.resources['hullUniforms'].uniforms;
    this.schreibeRect(unter.texture, uniforms.uRect1 as Float32Array);
    this.schreibeRect(ueber.texture, uniforms.uRect2 as Float32Array);
    uniforms.uMix = anteil;
    const farbe = uniforms.uTint as Float32Array;
    farbe[0] = ((tint >> 16) & 0xff) / 255;
    farbe[1] = ((tint >> 8) & 0xff) / 255;
    farbe[2] = (tint & 0xff) / 255;
    uniforms.uAlpha = alpha;
  }

  /** UVs der vier Quad-Ecken unter der INVERSEN Abbildung dieses Frames. */
  private schreibeUV(frame: DirectionFrame, rotation: number, ziel: Float32Array): void {
    const quelle = frame.texture.source;
    const rekt = frame.texture.frame;
    const w = frame.texture.width * frame.metresPerPx;
    const h = frame.texture.height * frame.metresPerPx;
    const c = Math.cos(-rotation);
    const s = Math.sin(-rotation);
    for (let i = 0; i < 4; i += 1) {
      const qx = this.positionen[i * 2]!;
      const qy = this.positionen[i * 2 + 1]!;
      // Zurückdrehen, auf Framegröße normieren, Anker addieren → Frame-Anteil.
      const lx = qx * c - qy * s;
      const ly = qx * s + qy * c;
      const tx = lx / w + frame.anchor.x;
      const ty = ly / h + frame.anchor.y;
      ziel[i * 2] = (rekt.x + tx * rekt.width) / quelle.width;
      ziel[i * 2 + 1] = (rekt.y + ty * rekt.height) / quelle.height;
    }
  }

  private schreibeRect(texture: Texture, ziel: Float32Array): void {
    const quelle = texture.source;
    const rekt = texture.frame;
    ziel[0] = rekt.x / quelle.width;
    ziel[1] = rekt.y / quelle.height;
    ziel[2] = rekt.width / quelle.width;
    ziel[3] = rekt.height / quelle.height;
  }

  override destroy(): void {
    const geometry = this.geometry;
    const shader = this.shader;
    super.destroy();
    // Wie beim Ozean: Geometry und Shader hängen nicht an den DestroyOptions.
    geometry.destroy(true);
    shader?.destroy(true);
  }
}
