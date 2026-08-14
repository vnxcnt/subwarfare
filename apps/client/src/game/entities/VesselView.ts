import { DEG, DEFAULT_VESSEL_MODEL, HULL_DIMENSIONS, angleDelta } from '@subwarfare/shared';
import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { HULL, WAKE } from '../../config';
import { foamTexture, smokeTexture } from '../fx-textures';
import { RENDER_ELEVATION, getTilt, screenAxisAngle } from '../Projection';
import { directionFrame, directionFramePair, hasVesselTextures, periscopeFrame } from '../textures';
import { HullBlendMesh } from './HullBlendMesh';
import type { Vessel } from '@subwarfare/shared';

const HALF = HULL.length / 2;
const BEAM = HULL.beam / 2;

/** Rumpfumriss von oben, Bug bei -y, Drehpunkt mittschiffs. Nur Fallback. */
const SILHOUETTE = [
  0, -HALF,
  BEAM * 0.42, -HALF * 0.84,
  BEAM * 0.77, -HALF * 0.62,
  BEAM, -HALF * 0.29,
  BEAM, HALF * 0.47,
  BEAM * 0.83, HALF * 0.69,
  BEAM * 0.5, HALF * 0.87,
  BEAM * 0.27, HALF,
  -BEAM * 0.27, HALF,
  -BEAM * 0.5, HALF * 0.87,
  -BEAM * 0.83, HALF * 0.69,
  -BEAM, HALF * 0.47,
  -BEAM, -HALF * 0.29,
  -BEAM * 0.77, -HALF * 0.62,
  -BEAM * 0.42, -HALF * 0.84,
];

const PING_SECONDS = 0.3;

/** Lebensdauer eines Rauchpartikels in Sekunden. */
const SMOKE_MAX_AGE = 3.4;

/** Eckenzahl des Kontaktschattens — genug, dass die Ellipse rund wirkt. */
const SHADOW_SEGMENTS = 20;

/**
 * Wie weit das Sprite eines Frames nachgedreht werden muss, damit der Rumpf
 * auf dem Bildschirm exakt auf den echten Kurs zeigt.
 *
 * ⚠️ NICHT einfach die Kursdifferenz nehmen. Das Sprite ist ein Render aus
 * 50° Höhe und trägt damit eine Verkürzung in sich: eine Azimut-Stufe von
 * 5,625° dreht die scheinbare Rumpfachse im Bild um 7,3°. Mit der linearen
 * Differenz blieb an jeder der 64 Framegrenzen ein Sprung stehen — gemessen
 * ein Grad, viermal so viel wie die Kursänderung zwischen zwei Bildern, und
 * beim Drehen alle 0,7 Sekunden sichtbar.
 *
 * Richtig ist die Differenz der SCHEINBAREN Achsen: die des Ziels in der
 * Karten-Projektion, die des Bildes in der Render-Perspektive.
 */
function restwinkel(frameKurs: number, echterKurs: number): number {
  return screenAxisAngle(echterKurs, getTilt()) - screenAxisAngle(frameKurs, RENDER_ELEVATION);
}

/**
 * Die sichtbare Seite eines Fahrzeugs — ein Richtungs-Billboard (64 Ansichten
 * je Modell), seit dem Blend-Umbau mit **kontinuierlichem Übergang**:
 *
 * Zu jedem Kurs liegen die beiden NACHBAR-Ansichten übereinander — die untere
 * voll deckend, die obere mit dem Winkelanteil als Deckkraft — und beide sind
 * um ihren Restwinkel exakt auf den echten Kurs gedreht. An der Rastergrenze
 * ist die obere exakt voll deckend und übernimmt als neue untere: es gibt
 * keinen Umschaltmoment mehr. (Der frühere zeitgesteuerte Geist-Crossfade von
 * 130 ms kaschierte den Perspektivsprung nur — beim Drehen blieb ein
 * sichtbares Pulsieren im Takt der Rasterwechsel.)
 *
 * Deshalb lebt das Billboard in der AUFRECHTEN `entityLayer`: dort ist die
 * Restdrehung eine echte Bildschirmdrehung. In der gekippten Wasserebene
 * würde die Projektion das gedrehte Bild scheren (P·R ≠ R·P bei
 * anisotroper Stauchung). Der Preis: die Weltposition muss VORPROJIZIERT
 * werden (`y · tilt`), weil diese Ebene die Stauchung nicht selbst anwendet.
 *
 * Die Wegpunktgrafik bleibt in der Wasserebene — Linien und Ringe liegen
 * flach auf dem Wasser und sollen die Projektion gerade mitmachen.
 */
export class VesselView {
  private readonly root = new Container();
  private readonly hull: HullBlendMesh | Graphics;
  private readonly order = new Graphics();

  /**
   * Kielwasser: Schaumspur aus der Positionshistorie plus Bugwellen-V. Liegt
   * wie die Wegpunktgrafik IN der Wasserebene — Schaum liegt AUF dem Wasser
   * und soll die Projektion mitmachen.
   *
   * Der Schaum besteht aus Sprites, nicht aus Strichen: eine Linie mit runder
   * Kappe ist eine Linie, egal wie breit man sie zieht. Die Kontur des
   * Schaumbatzens macht den Unterschied.
   */
  private readonly wakeRoot = new Container();
  private readonly wakeShapes = new Graphics();
  private readonly foamLayer = new Container();
  private readonly foamPool: Sprite[] = [];
  private readonly wakeSamples: Array<{
    x: number;
    y: number;
    age: number;
    /** Kurs beim Ablegen der Probe — bestimmt, wohin die Spur auseinanderläuft. */
    heading: number;
    /** Fahrtanteil beim Ablegen: langsame Fahrt hinterlässt blasseren Schaum. */
    strength: number;
    /** Feste Zufallsdrehung, damit sich die Batzen nicht als Muster wiederholen. */
    spin: number;
  }> = [];
  /** Läuft mit, damit die Bugsee atmet statt starr am Bug zu kleben. */
  private sprayPhase = 0;
  /** Umriss des Kontaktschattens, wiederverwendet — das läuft jeden Frame. */
  private readonly shadowPoints = new Array<number>(SHADOW_SEGMENTS * 2).fill(0);

  /** Periskop — sichtbar nur, wenn das Modell eines gesetzt hat (depth+periscope). */
  private readonly periscope: Sprite | null = null;

  /**
   * Schadensrauch: aufsteigende, wachsende, verblassende Rauchballen ÜBER dem
   * Rumpf. Lebt im aufrechten Billboard-Container — Rauch steigt senkrecht im
   * Bild, die Wasserebene würde ihn flach scheren.
   */
  private readonly smokeLayer = new Container();
  private readonly smokePool: Sprite[] = [];
  private readonly smokeParticles: Array<{
    x: number;
    /** Bildschirm-Drift pro Sekunde: Fahrtwind nach achtern plus Seitenwind. */
    vx: number;
    vy: number;
    age: number;
    dark: boolean;
    spin: number;
    turn: number;
  }> = [];
  private smokeSpawnIn = 0;

  private lastSerial = -1;
  private pingAge = PING_SECONDS;

  constructor() {
    // Schatten und Bugwellen-V unter den Schaum: der Schaum liegt obenauf.
    this.wakeRoot.addChild(this.wakeShapes, this.foamLayer);

    this.hull = createHull();
    this.root.addChild(this.hull);

    if (this.hull instanceof HullBlendMesh) {
      const frame = periscopeFrame(0);
      if (frame) {
        this.periscope = new Sprite({ texture: frame.texture, anchor: frame.anchor, visible: false });
        this.root.addChild(this.periscope);
      }
    }

    // Rauch als OBERSTES Kind — er soll über Rumpf und Aufbauten liegen.
    this.root.addChild(this.smokeLayer);
  }

  /** Außerhalb der optischen Sicht wird gar nicht erst gezeichnet. */
  setVisible(visible: boolean): void {
    this.root.visible = visible;
    this.order.visible = visible;
    this.wakeRoot.visible = visible;
  }

  /**
   * Alterung OHNE Zeichnen — für Fahrzeuge außerhalb der optischen Sicht.
   *
   * `EntityLayer.syncViews` ruft `sync` für sie nicht auf. Ohne diesen Tick
   * stünde die Schaumspur eingefroren im Vorrat: verschwindet ein Kontakt für
   * eine Minute aus dem Sichtkreis und taucht wieder auf, erschiene schlagartig
   * eine 22 s alte Spur, als wäre sie eben entstanden. Bei der früheren
   * Lebensdauer von 3,5 s fiel das nicht auf, bei 22 s sehr wohl.
   *
   * Kostet nur das Fortschreiben zweier Zahlenlisten — es werden weder Sprites
   * angefasst noch Geometrie neu gebaut.
   */
  age(frameSeconds: number): void {
    for (const sample of this.wakeSamples) sample.age += frameSeconds;
    while (
      this.wakeSamples.length > 0 &&
      (this.wakeSamples[0]!.age > WAKE.maxAgeSeconds || this.wakeSamples.length > WAKE.maxSamples)
    ) {
      this.wakeSamples.shift();
    }

    for (const particle of this.smokeParticles) particle.age += frameSeconds;
    while (this.smokeParticles.length > 0 && this.smokeParticles[0]!.age > SMOKE_MAX_AGE) {
      this.smokeParticles.shift();
    }
  }

  attach(waterLayer: Container, billboardLayer: Container): void {
    // Spur zuerst — sie soll UNTER Wegpunktgrafik und Effekten liegen.
    waterLayer.addChild(this.wakeRoot, this.order);
    billboardLayer.addChild(this.root);
  }

  /**
   * ENDLOS-KARTE: die Schaumspur ist der einzige Bestand dieser Ansicht in
   * ABSOLUTEN Weltkoordinaten — beim Rebase wandert sie mit dem Schiff mit.
   * Rauch ist schiffslokal, Position und Schatten entstehen jeden Frame neu.
   */
  rebase(dx: number, dy: number): void {
    for (const sample of this.wakeSamples) {
      sample.x += dx;
      sample.y += dy;
    }
  }

  sync(model: Vessel, zoom: number, frameSeconds: number, isOwn = false): void {
    // Alterung an EINER Stelle — dieselbe, die auch für unsichtbare Fahrzeuge
    // läuft. Getrennte Zähler in drawWake und updateSmoke wären zwangsläufig
    // irgendwann auseinandergelaufen.
    this.age(frameSeconds);

    // Vorprojiziert: die aufrechte Ebene staucht nicht selbst, also muss die
    // Position die Stauchung mitbringen. `tilt` pro Frame gelesen — er ist
    // zur Laufzeit verstellbar.
    this.root.position.set(model.x, model.y * getTilt());
    // Maleralgorithmus: was weiter südlich liegt, liegt weiter vorne.
    // Sortiert wird nach WELT-y — der Faktor tilt wäre für die Ordnung egal,
    // aber ganzzahliges Welt-y ist stabiler gegen Rundungsflattern.
    this.root.zIndex = Math.round(model.y);

    // Tauch-Darstellung vorziehen — Tint und Deckkraft gehen mit ins Mesh.
    const depth = Math.min(Math.max(model.depth, 0), 1);
    const hullAlpha = 1 - depth * (isOwn ? 0.45 : 1);

    if (this.hull instanceof HullBlendMesh) {
      const paar = directionFramePair(model.model, model.rotation);
      if (paar) {
        const { unter, ueber, anteil } = paar;
        /*
         * Smoothstep statt linearer Rampe: die lineare Blende hat an den
         * Rasterenden harte KNICKE in der Änderungsrate — sichtbar als kurzes
         * „Einrasten" in die reine Ansicht. Mit weichem Ein- und Auslauf ruht
         * die Perspektive an den Enden und überblendet in der Mitte flotter.
         */
        const weich = anteil * anteil * (3 - 2 * anteil);
        /*
         * Beide Ansichten zeigen per Restwinkel auf den ECHTEN Kurs; gemischt
         * wird PRO PIXEL im Shader — siehe HullBlendMesh, warum zwei Sprites
         * das nicht sauber können.
         */
        this.hull.setPair(
          unter,
          ueber,
          weich,
          restwinkel(unter.angleDegrees, model.rotation),
          restwinkel(ueber.angleDegrees, model.rotation),
          tintForDepth(depth),
          hullAlpha,
        );
      }
    } else {
      // Fallback-Polygon dreht klassisch mit dem Kurs. In der aufrechten
      // Ebene erscheint es ungestaucht — für das Sicherheitsnetz akzeptiert.
      this.hull.rotation = model.rotation * DEG;
    }

    // Tauch-Darstellung: getauchte Boote rutschen optisch unter die
    // Wasseroberfläche — dunkler getönt und durchscheinend. Fremde
    // verschwinden bei voller Tiefe GANZ (sichtbar bleibt höchstens ihr
    // Periskop), das eigene bleibt als Schemen lesbar. Tint/Alpha stecken im
    // Mesh (oben mitgegeben), NICHT am Root — das Periskop ragt über Wasser
    // und bleibt klar. Nur das Fallback-Polygon braucht die Deckkraft hier.
    if (!(this.hull instanceof HullBlendMesh)) this.hull.alpha = hullAlpha;

    // Periskop: erscheint mit dem Ausfahren, wächst mit dem Ausfahrstand und
    // ist nur relevant, wenn das Boot (teilweise) unter Wasser liegt.
    if (this.periscope) {
      const extend = Math.min(Math.max(model.periscope, 0), 1);
      const relevant = extend > 0.02 && depth > 0.3;
      this.periscope.visible = relevant;
      if (relevant) {
        const frame = periscopeFrame(model.rotation);
        if (frame) {
          if (this.periscope.texture !== frame.texture) {
            this.periscope.texture = frame.texture;
            this.periscope.anchor.set(frame.anchor.x, frame.anchor.y);
          }
          this.periscope.width = frame.texture.width * frame.metresPerPx;
          // Höhe wächst mit dem Ausfahren — das „Aufsteigen" aus dem Wasser.
          this.periscope.height = frame.texture.height * frame.metresPerPx * extend;
          // Derselbe Restwinkel wie beim Rumpf — das Periskop stammt aus
          // derselben Turntable-Reihe und hat denselben Sprung an den Grenzen.
          this.periscope.rotation = restwinkel(frame.angleDegrees, model.rotation);
        }
      }
    }

    // Gegenskalierung, damit der Rumpf bei Übersichtszoom nicht verschwindet.
    // Bezugsgröße bleibt die projizierte Schiffslänge — für die Billboards eine
    // Näherung, aber als Mindestgrößen-Wächter genau richtig.
    const screenLength = HULL.length * getTilt() * zoom;
    const boost = HULL.minScreenPx / screenLength;
    this.root.scale.set(Math.min(Math.max(boost, 1), HULL.maxBoost));

    this.drawOrder(model, zoom, frameSeconds);
    this.drawWake(model, frameSeconds);
    this.updateSmoke(model, frameSeconds);
  }

  /**
   * Schadensrauch: Stufe 1 (weiß, HP < 50 %) qualmt gemächlich, Stufe 2
   * (schwarz, HP < 20 %) dicht und dunkel. Partikel steigen auf, driften
   * leicht nach Lee, wachsen und verblassen. Unter Wasser raucht nichts.
   */
  private updateSmoke(model: Vessel, frameSeconds: number): void {
    const level = model.smoke;
    const active = level > 0 && model.depth < 0.5;
    // Die Alterung der Partikel ist bereits in `age()` passiert.

    if (active) {
      this.smokeSpawnIn -= frameSeconds;
      if (this.smokeSpawnIn <= 0) {
        this.smokeSpawnIn = level === 2 ? 0.13 : 0.26;
        // Fahrtwind: der Qualm bleibt zurück, während das Schiff weiterfährt.
        // Ohne das klebt die Fahne am Schornstein, egal wie schnell es läuft.
        // Richtung im BILD, nicht in der Welt — der Rauch lebt in der
        // aufrechten Ebene, deren y-Achse die Kippung schon eingerechnet hat.
        const heading = model.rotation * DEG;
        const achtern = -Math.min(Math.abs(model.speed), 40) * 0.6;
        // `Math.random` ist hier erlaubt: reine Client-Optik, keine Simulation.
        this.smokeParticles.push({
          x: (Math.random() - 0.5) * 8,
          vx: Math.sin(heading) * achtern + (Math.random() - 0.5) * 6,
          vy: -Math.cos(heading) * achtern * getTilt() + (Math.random() - 0.5) * 4,
          age: 0,
          dark: level === 2,
          spin: Math.random() * Math.PI * 2,
          turn: (Math.random() - 0.5) * 0.9,
        });
        if (this.smokeParticles.length > 32) this.smokeParticles.shift();
      }
    }

    const texture = smokeTexture();
    let used = 0;
    if (texture) {
      for (const particle of this.smokeParticles) {
        const t = particle.age / SMOKE_MAX_AGE;
        const alpha = (particle.dark ? 0.85 : 0.55) * (1 - t);
        if (alpha < 0.015) continue;
        const sprite = this.smokeAt(used, texture);
        used += 1;
        // Aufsteigend, nach Lee driftend, wachsend — und langsam drehend,
        // damit der Ballen quillt statt nur größer zu werden.
        const size = 10 + t * 38;
        sprite.position.set(
          particle.x + particle.vx * particle.age,
          -(6 + particle.age * 16) + particle.vy * particle.age,
        );
        sprite.width = size;
        sprite.height = size;
        sprite.alpha = alpha;
        sprite.rotation = particle.spin + particle.turn * particle.age;
        // ⚠️ Der schwarze Rauch muss DEUTLICH dunkler sein als das Wasser
        // (≈0x192830). Mit einem mittleren Grau war er zwar da — 14 Sprites im
        // Baum —, aber vom Ozean nicht zu unterscheiden.
        sprite.tint = particle.dark ? 0x0a0d10 : 0xe8eef2;
      }
    }
    for (let i = used; i < this.smokePool.length; i += 1) this.smokePool[i]!.visible = false;
    for (let i = 0; i < used; i += 1) this.smokePool[i]!.visible = true;
  }

  private smokeAt(index: number, texture: Texture): Sprite {
    let sprite = this.smokePool[index];
    if (!sprite) {
      sprite = new Sprite({ texture, anchor: 0.5 });
      this.smokePool.push(sprite);
      this.smokeLayer.addChild(sprite);
    }
    return sprite;
  }

  detach(): void {
    this.order.removeFromParent();
    this.wakeRoot.removeFromParent();
    this.root.removeFromParent();
  }

  destroy(): void {
    this.detach();
    // `context: true` ist nötig — die eigenen GraphicsContexts hängen nicht an
    // den Default-DestroyOptions und blieben sonst samt Geometrie auf der GPU.
    // Die Effekt-Texturen sind geteilt und werden bewusst NICHT mitzerstört.
    this.order.destroy({ context: true });
    this.wakeRoot.destroy({ children: true, context: true });
    this.root.destroy({ children: true, context: true });
  }

  /**
   * Kielwasser: hinter dem Heck bleibt eine alternde Schaumspur liegen, vor
   * dem Bug öffnet sich das V der Bugwelle. Alles ∝ Fahrt; ein getauchtes
   * Boot hinterlässt an der Oberfläche nichts (Faktor 1 − depth).
   */
  private drawWake(model: Vessel, frameSeconds: number): void {
    const g = this.wakeShapes;
    this.sprayPhase += frameSeconds;
    // Die Alterung der Proben ist bereits in `age()` passiert.

    const speedRatio =
      model.maxForward > 0 ? Math.min(Math.abs(model.speed) / model.maxForward, 1) : 0;
    const surface = 1 - Math.min(Math.max(model.depth, 0), 1);
    const intensity = speedRatio * surface;

    const dims = HULL_DIMENSIONS[model.model] ?? HULL_DIMENSIONS[DEFAULT_VESSEL_MODEL];
    const heading = model.rotation * DEG;
    const forwardX = Math.sin(heading);
    const forwardY = -Math.cos(heading);
    const sternX = model.x - forwardX * dims.length * 0.42;
    const sternY = model.y - forwardY * dims.length * 0.42;

    const newest = this.wakeSamples[this.wakeSamples.length - 1];
    if (
      intensity > 0.05 &&
      (!newest || Math.hypot(sternX - newest.x, sternY - newest.y) > WAKE.minSampleDistance)
    ) {
      // `Math.random` ist hier erlaubt: reine Client-Optik, keine Simulation.
      this.wakeSamples.push({
        x: sternX,
        y: sternY,
        age: 0,
        heading,
        strength: intensity,
        spin: Math.random() * Math.PI * 2,
      });
    }

    g.clear();
    this.drawContactShadow(model, dims, heading, surface);

    const bowX = model.x + forwardX * dims.length * 0.5;
    const bowY = model.y + forwardY * dims.length * 0.5;
    this.drawFoam(model, dims, intensity, bowX, bowY, sternX, sternY);
  }

  /**
   * Kontaktschatten unter dem Rumpf.
   *
   * Ohne ihn klebt das Billboard wie ein Aufkleber auf dem Wasser — es fehlt
   * jeder Hinweis, dass der Rumpf im Wasser LIEGT. Bewusst zentriert statt in
   * Sonnenrichtung versetzt: das ist keine Schlagschatten-Simulation, sondern
   * die Verdrängung und Verschattung direkt unter dem Schiff.
   */
  private drawContactShadow(
    model: Vessel,
    dims: { length: number; beam: number },
    heading: number,
    surface: number,
  ): void {
    if (surface <= 0.05) return;

    const halfLength = dims.length * 0.52;
    const halfBeam = dims.beam * 0.62;
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    for (let i = 0; i < SHADOW_SEGMENTS; i += 1) {
      const a = (i / SHADOW_SEGMENTS) * Math.PI * 2;
      const quer = Math.sin(a) * halfBeam;
      const laengs = Math.cos(a) * halfLength;
      this.shadowPoints[i * 2] = model.x + quer * cos + laengs * sin;
      this.shadowPoints[i * 2 + 1] = model.y + quer * sin - laengs * cos;
    }
    // Deutlich dunkler als das Wasser gewählt: bei 0x04141d lag der Schatten so
    // nah am Ozeanblau, dass er schlicht nicht zu sehen war.
    this.wakeShapes
      .poly(this.shadowPoints, true)
      .fill({ color: 0x01070b, alpha: WAKE.shadowAlpha * surface });
  }

  /**
   * Schaum als Sprites: je Probe zwei Batzen links und rechts der Spurmitte,
   * dazu Bugsee und die beiden Kelvin-Schenkel. Ein Strich mit runder Kappe
   * bleibt ein Strich — erst die ausgefranste Kontur sieht nach Schaum aus,
   * und genau daran scheiterte die vorherige `Graphics`-Fassung.
   */
  private drawFoam(
    model: Vessel,
    dims: { length: number; beam: number },
    intensity: number,
    bowX: number,
    bowY: number,
    sternX: number,
    sternY: number,
  ): void {
    const texture = foamTexture();
    if (!texture) return;

    let used = 0;
    for (const sample of this.wakeSamples) {
      const t = sample.age / WAKE.maxAgeSeconds;
      /*
       * Einblendrampe: frisch abgelegte Batzen BLÜHEN AUF, statt fertig ins
       * Bild zu poppen — ohne sie erschien alle `minSampleDistance` Meter ein
       * Schaumfleck in voller Deckkraft. Smoothstep statt linear, damit auch
       * das Ende der Rampe ohne Knick in die Abkling-Kurve übergeht.
       */
      const roh = Math.min(sample.age / WAKE.fadeInSeconds, 1);
      const einblenden = roh * roh * (3 - 2 * roh);
      const alpha = WAKE.foamAlpha * sample.strength * einblenden * (1 - t) ** WAKE.fadeExponent;
      if (alpha < 0.012) continue;

      const spread = dims.beam * (WAKE.spreadStart + t * (WAKE.spreadEnd - WAKE.spreadStart));
      // Beim Aufblühen wächst der Batzen von 60 % auf volle Größe mit.
      const size =
        dims.beam *
        (WAKE.puffStart + t * (WAKE.puffEnd - WAKE.puffStart)) *
        (0.6 + 0.4 * einblenden);
      const quer = Math.cos(sample.heading);
      const laengs = Math.sin(sample.heading);

      // Mitte zuerst, blasser und breiter: die beiden Randbahnen allein lasen
      // sich als zwei getrennte Streifen mit einem Loch dazwischen — dabei ist
      // gerade die Mitte der Spur das aufgewühlte Wasser.
      const mitte = this.foamAt(used, texture);
      used += 1;
      mitte.position.set(sample.x, sample.y);
      mitte.width = size * 1.35;
      mitte.height = mitte.width;
      mitte.alpha = alpha * WAKE.centreAlpha;
      mitte.rotation = sample.spin * 2.3;

      for (const side of [-1, 1]) {
        const sprite = this.foamAt(used, texture);
        used += 1;
        sprite.position.set(sample.x + quer * spread * side, sample.y + laengs * spread * side);
        sprite.width = size;
        sprite.height = size;
        sprite.alpha = alpha;
        sprite.rotation = sample.spin + side * 1.7;
      }
    }

    if (intensity > 0.08) {
      const puls = 0.85 + 0.15 * Math.sin(this.sprayPhase * 5.5);

      // Schraubenwasser: der hellste Fleck der ganzen Spur sitzt direkt am
      // Heck. Die jüngste Probe liegt bis zu `minSampleDistance` dahinter —
      // ohne diesen Batzen klaffte dort die Lücke, die vorher die Linie zum
      // Heck geschlossen hat.
      const kochen = this.foamAt(used, texture);
      used += 1;
      kochen.position.set(sternX, sternY);
      kochen.width = dims.beam * 2.4 * puls;
      kochen.height = kochen.width;
      kochen.alpha = WAKE.foamAlpha * intensity;
      kochen.rotation = this.sprayPhase * 1.4;

      // Bugsee: EIN kleiner Batzen direkt an der Bugspitze — mehr nicht.
      // Die Kelvin-Schenkel (das große Schaum-V vor dem Bug) sind bewusst
      // raus: sie lasen sich wie ein Anbau am Schiff statt wie Wasser. Was
      // Fahrt erzählt, ist die Heckspur; der Bug bekommt nur einen Tupfer
      // Gischt, wo der Rumpf einschneidet.
      const bug = this.foamAt(used, texture);
      used += 1;
      bug.position.set(bowX, bowY);
      bug.width = dims.beam * 0.8 * puls;
      bug.height = bug.width;
      bug.alpha = 0.3 * intensity;
      bug.rotation = this.sprayPhase * 0.6;
    }

    // Übrige Sprites aus dem Vorrat bleiben liegen, aber unsichtbar — sie
    // jedes Mal neu anzulegen wäre der teure Weg.
    for (let i = used; i < this.foamPool.length; i += 1) this.foamPool[i]!.visible = false;
    for (let i = 0; i < used; i += 1) this.foamPool[i]!.visible = true;
  }

  private foamAt(index: number, texture: Texture): Sprite {
    let sprite = this.foamPool[index];
    if (!sprite) {
      sprite = new Sprite({ texture, anchor: 0.5 });
      sprite.tint = WAKE.foamColor;
      this.foamPool.push(sprite);
      this.foamLayer.addChild(sprite);
    }
    return sprite;
  }

  private drawOrder(model: Vessel, zoom: number, frameSeconds: number): void {
    this.order.clear();

    const waypoint = model.waypoint;
    if (!waypoint) return;

    if (model.serial !== this.lastSerial) {
      this.lastSerial = model.serial;
      this.pingAge = 0;
    }
    this.pingAge = Math.min(this.pingAge + frameSeconds, PING_SECONDS);

    // Mindestgröße in Bildschirmpixeln, sonst ist der Marker beim Rausgezoomten
    // ein Punkt.
    const radius = Math.max(HULL.markerRadius, 12 / zoom);
    const ping = 1 - this.pingAge / PING_SECONDS;

    this.order
      .moveTo(model.x, model.y)
      .lineTo(waypoint.x, waypoint.y)
      .stroke({ color: HULL.markerColor, alpha: 0.3, pixelLine: true });

    this.order
      .circle(waypoint.x, waypoint.y, radius)
      .stroke({ color: HULL.markerColor, alpha: 0.75, pixelLine: true });

    if (ping > 0) {
      this.order
        .circle(waypoint.x, waypoint.y, radius * (1 + ping * 1.6))
        .stroke({ color: HULL.markerColor, alpha: 0.5 * ping, pixelLine: true });
    }
  }
}

/**
 * Der Rumpf als Richtungs-Sprite, wenn die Grafiken geladen sind — sonst als
 * Vektorpolygon. Der Fallback ist kein Notbehelf: er hält den Client
 * lauffähig, bevor Assets da sind, und bleibt die Referenz für Schiffstypen
 * ohne eigene Grafik.
 */
/**
 * Tönung nach Tiefe: von Weiß (keine Änderung) zu tiefem Grünblau. Multiplikativ
 * auf dem Container — färbt Rumpf UND Crossfade-Geist gleichermaßen. Exportiert,
 * weil auch Projektile (Torpedos laufen UNTER Wasser) dieselbe Optik tragen.
 */
export function tintForDepth(depth: number): number {
  const r = Math.round(255 - depth * (255 - 0x4e));
  const g = Math.round(255 - depth * (255 - 0x7a));
  const b = Math.round(255 - depth * (255 - 0x8e));
  return (r << 16) | (g << 8) | b;
}

function createHull(): HullBlendMesh | Graphics {
  if (hasVesselTextures()) {
    const frame = directionFrame(DEFAULT_VESSEL_MODEL, 0);
    if (frame) {
      // Die Anker (Modell-Pivots aus den Meshy-Metadaten) verrechnet das
      // Mesh je Frame selbst — alle Ansichten sitzen exakt auf demselben
      // Weltpunkt, gedreht wird um den Rumpf statt um die Bildmitte.
      return new HullBlendMesh(frame.texture);
    }
  }

  const graphics = new Graphics()
    .poly(SILHOUETTE, true)
    .fill({ color: HULL.fill, alpha: 0.95 })
    // Die Füllfarbe liegt zwangsläufig nah am Ozeanblau — ohne helle 1-px-Kontur
    // verschwindet der Rumpf im Wasser.
    .stroke({ color: HULL.stroke, alpha: 0.9, pixelLine: true });

  graphics
    .rect(-BEAM * 0.75, -HALF * 0.23, BEAM * 1.5, HALF * 0.04)
    .fill({ color: HULL.stroke, alpha: 0.5 });

  // Kursstrich vor dem Bug — bei kleinem Zoom oft das Einzige, woran man die
  // Fahrtrichtung noch erkennt.
  graphics
    .moveTo(0, -HALF)
    .lineTo(0, -HALF * 1.42)
    .stroke({ color: HULL.stroke, alpha: 0.45, pixelLine: true });

  return graphics;
}
