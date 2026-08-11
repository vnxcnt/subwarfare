import { AUDIO } from '../config';
import { volumes } from '../state/settings';

import ambientUnderwaterUrl from '../assets/audio/ambient_underwater01.mp3';
import ambientWaterUrl from '../assets/audio/ambient_water.mp3';
import engineShipUrl from '../assets/audio/engine_ship.mp3';
import engineSubmarineUrl from '../assets/audio/engine_submarine.mp3';
import fireGunUrl from '../assets/audio/firing_gun.mp3';
import fireSubmarineUrl from '../assets/audio/firing_torpedo01.mp3';
import fireShipUrl from '../assets/audio/firing_torpedo02.mp3';
import impactUrl from '../assets/audio/impact_shell02.mp3';

/** Zustand des eigenen Boots, soweit der Klang ihn braucht. Null = versenkt. */
export interface AudioOwnState {
  /** Tauchtiefe 0..1 — Crossfade zwischen Oberflächen- und Unterwasserkulisse. */
  depth: number;
  /** |Fahrt| / Höchstfahrt, 0..1 — Lautstärke des Motors. */
  power: number;
  /** U-Boot laut Schiffskatalog — entscheidet Motor- und Abschussklang. */
  submarine: boolean;
}

/**
 * Zeitkonstante der Gain-Glättung in Sekunden. Die Werte kommen jeden Frame
 * neu — ohne Glättung würde jede Fahrtstufenänderung als Lautstärkesprung
 * knacken.
 */
const FADE_SECONDS = 0.12;

/**
 * Spielklang über Web Audio.
 *
 * Drei Dauerschleifen laufen ab dem Laden PERMANENT mit Gain 0 und werden nur
 * aufgeblendet (Oberfläche, Unterwasser, Motor je Bauart) — Quellen zu starten
 * und zu stoppen würde an jeder Naht knacken, ein stummer Loop kostet nichts.
 * Abschüsse und Einschläge sind One-Shots mit Entfernungsdämpfung.
 *
 * Alles hier ist REINE Darstellung: welche Ereignisse es gibt, entscheidet der
 * Server (state/fx) — der Klang hängt sich nur an, was der Client ohnehin weiß.
 */
export class GameAudio {
  private context: AudioContext | null = null;

  private ambientWater: GainNode | null = null;
  private ambientUnderwater: GainNode | null = null;
  private engineShip: GainNode | null = null;
  private engineSubmarine: GainNode | null = null;

  private fireShipBuffer: AudioBuffer | null = null;
  private fireSubmarineBuffer: AudioBuffer | null = null;
  private fireGunBuffer: AudioBuffer | null = null;
  private impactBuffer: AudioBuffer | null = null;

  private resumeListener: (() => void) | null = null;

  /**
   * Lädt und startet die Kulisse. Bewusst nicht awaited vom Spielstart — bis
   * die Puffer da sind, schweigt alles einfach (jede Methode prüft selbst).
   */
  async init(): Promise<void> {
    if (this.context) return;
    const context = new AudioContext();
    this.context = context;

    // Browser-Autoplay: die Route wird zwar per Klick betreten, aber wenn der
    // Kontext trotzdem angehalten startet, weckt ihn die nächste Eingabe.
    if (context.state === 'suspended') {
      const resume = (): void => {
        void context.resume();
        this.detachResume();
      };
      this.resumeListener = resume;
      window.addEventListener('pointerdown', resume);
      window.addEventListener('keydown', resume);
    }

    const load = async (url: string): Promise<AudioBuffer> => {
      const response = await fetch(url);
      // Ein 404 lieferte HTML — decodeAudioData würde daran kryptisch
      // scheitern statt am eigentlichen Problem.
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return context.decodeAudioData(await response.arrayBuffer());
    };

    const [water, underwater, ship, submarine, fireShip, fireSubmarine, fireGun, impact] =
      await Promise.all([
        load(ambientWaterUrl),
        load(ambientUnderwaterUrl),
        load(engineShipUrl),
        load(engineSubmarineUrl),
        load(fireShipUrl),
        load(fireSubmarineUrl),
        load(fireGunUrl),
        load(impactUrl),
      ]);

    // `destroy()` kann während des Ladens gelaufen sein (schneller Routenwechsel).
    if (this.context !== context) return;

    this.fireShipBuffer = fireShip;
    this.fireSubmarineBuffer = fireSubmarine;
    this.fireGunBuffer = fireGun;
    this.impactBuffer = impact;

    this.ambientWater = this.startLoop(context, water);
    this.ambientUnderwater = this.startLoop(context, underwater);
    this.engineShip = this.startLoop(context, ship);
    this.engineSubmarine = this.startLoop(context, submarine);
  }

  /** Einmal pro Frame: blendet die Dauerschleifen auf den aktuellen Zustand. */
  update(own: AudioOwnState | null): void {
    const context = this.context;
    if (!context) return;

    // Versenkt (null): Motor aus, Kulisse wie an der Oberfläche — Stille wäre
    // hier falscher als Wasser, man treibt ja im Geschehen.
    const depth = own ? Math.min(Math.max(own.depth, 0), 1) : 0;
    const power = own ? Math.min(Math.max(own.power, 0), 1) : 0;

    // Regler aus den Einstellungen: Kulisse und Motor/Effekte getrennt. Läuft
    // jeden Frame durch dieselbe Gain-Glättung — Sliderziehen knackt nicht.
    const ambient = volumes.value.ambient;
    const effects = volumes.value.effects;
    this.setGain(this.ambientWater, AUDIO.ambientWater * (1 - depth) * ambient);
    this.setGain(this.ambientUnderwater, AUDIO.ambientUnderwater * depth * ambient);
    this.setGain(this.engineShip, own && !own.submarine ? AUDIO.engineMax * power * effects : 0);
    this.setGain(this.engineSubmarine, own?.submarine ? AUDIO.engineMax * power * effects : 0);
  }

  /** Torpedoabschuss — U-Boot und Überwasserschiff klingen verschieden. */
  playFire(fromSubmarine: boolean, distanceMetres: number): void {
    this.playOnce(
      fromSubmarine ? this.fireSubmarineBuffer : this.fireShipBuffer,
      AUDIO.fire * falloff(distanceMetres) * volumes.value.effects,
    );
  }

  /** Geschützschuss — kurzer Knall, gleiche Entfernungsdämpfung. */
  playGunFire(distanceMetres: number): void {
    this.playOnce(this.fireGunBuffer, AUDIO.fire * falloff(distanceMetres) * volumes.value.effects);
  }

  /** Torpedoeinschlag (auch Versenkung — die ist nur der letzte Einschlag). */
  playImpact(distanceMetres: number): void {
    this.playOnce(
      this.impactBuffer,
      AUDIO.impact * falloff(distanceMetres) * volumes.value.effects,
    );
  }

  destroy(): void {
    this.detachResume();
    const context = this.context;
    this.context = null;
    this.ambientWater = null;
    this.ambientUnderwater = null;
    this.engineShip = null;
    this.engineSubmarine = null;
    if (context) void context.close();
  }

  private startLoop(context: AudioContext, buffer: AudioBuffer): GainNode {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = context.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(context.destination);
    source.start();
    return gain;
  }

  private setGain(gain: GainNode | null, value: number): void {
    if (!gain || !this.context) return;
    gain.gain.setTargetAtTime(value, this.context.currentTime, FADE_SECONDS);
  }

  private playOnce(buffer: AudioBuffer | null, volume: number): void {
    const context = this.context;
    // Unhörbares gar nicht erst starten — jenseits der Hörweite fällt volume auf 0.
    if (!context || !buffer || volume <= 0.01 || context.state !== 'running') return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(context.destination);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
    source.start();
  }

  private detachResume(): void {
    if (!this.resumeListener) return;
    window.removeEventListener('pointerdown', this.resumeListener);
    window.removeEventListener('keydown', this.resumeListener);
    this.resumeListener = null;
  }
}

/** Linearer Lautstärkeabfall mit der Entfernung, 1 am Ohr, 0 ab Hörweite. */
function falloff(distanceMetres: number): number {
  return Math.min(Math.max(1 - distanceMetres / AUDIO.hearingRangeMetres, 0), 1);
}
