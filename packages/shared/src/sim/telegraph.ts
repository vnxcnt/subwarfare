import { autopilot, throttleFor } from './movement.js';
import type { Command, VesselMotion, VesselProfile, Waypoint } from './VesselProfile.js';

export interface TelegraphStep {
  label: string;
  /** Kurzform für enge Anzeigen. */
  short: string;
  /**
   * Anteil der Höchstfahrt. Positiv bezieht sich auf `maxForward`,
   * negativ auf den Betrag von `maxReverse` — dadurch gilt dieselbe Leiter
   * für jedes Boot, unabhängig von seiner Leistung.
   */
  fraction: number;
}

/**
 * Rasten eines Maschinentelegrafen, aufsteigend sortiert.
 *
 * Die Sortierung IST die Rasterung: „eine Stufe schneller" ist `index + 1`,
 * geklemmt auf die Länge. Wer hier einfügt, muss die Reihenfolge halten.
 */
export const TELEGRAPH_STANDARD: readonly TelegraphStep[] = [
  { label: 'Volle Kraft zurück', short: 'VKZ', fraction: -1 },
  { label: 'Halbe Fahrt zurück', short: 'HFZ', fraction: -2 / 3 },
  { label: 'Kleine Fahrt zurück', short: 'KFZ', fraction: -1 / 3 },
  { label: 'Maschine stopp', short: 'STOPP', fraction: 0 },
  { label: 'Kleine Fahrt', short: 'KF', fraction: 0.2 },
  { label: 'Halbe Fahrt', short: 'HF', fraction: 0.4 },
  { label: 'Marschfahrt', short: 'MF', fraction: 0.6 },
  { label: 'Große Fahrt', short: 'GF', fraction: 0.85 },
  { label: 'Äußerste Kraft', short: 'ÄK', fraction: 1 },
];

/** Index von „Maschine stopp". Startstellung jedes Fahrzeugs. */
export const TELEGRAPH_STOP = 3;
/** Stufe, auf die ein Fahrbefehl das Telegrafen hebt, wenn die Maschine steht. */
export const TELEGRAPH_CRUISE = 6;

export function clampStep(step: number): number {
  return Math.min(Math.max(Math.round(step), 0), TELEGRAPH_STANDARD.length - 1);
}

export function telegraphStep(step: number): TelegraphStep {
  return TELEGRAPH_STANDARD[clampStep(step)] as TelegraphStep;
}

/** Befohlene Fahrt einer Rast in m/s. Negativ bedeutet Rückwärtsfahrt. */
export function orderedSpeed(profile: VesselProfile, step: number): number {
  const { fraction } = telegraphStep(step);
  return fraction >= 0 ? fraction * profile.maxForward : Math.abs(fraction) * profile.maxReverse;
}

/**
 * Der einzige Ort, an dem Wegpunkt und Telegrafenstufe zusammenkommen.
 *
 * Die Zustandslogik in Worten:
 * - **Ohne Ziel** wird die befohlene Fahrt geradeaus gefahren, das Ruder bleibt
 *   mittschiffs.
 * - **Rückwärts** ist eine Handmanöver-Stufe: auch mit gesetztem Ziel wird nur
 *   zurückgesetzt, nicht gesteuert. Ein rückwärts angesteuerter Wegpunkt wäre
 *   sinnlos, und `Vessel.setTelegraph` löscht ihn deshalb ohnehin.
 * - **Mit Ziel** deckelt die Stufe die Fahrt des Autopiloten. Sie ist eine
 *   Obergrenze, keine Vorgabe: bremst der Autopilot vor dem Ziel oder wegen
 *   eines engen Kurses stärker, gewinnt er.
 * - **Maschine stopp mit Ziel** fällt automatisch richtig aus: die Obergrenze 0
 *   nimmt die Fahrt weg, das Ruder hält weiter aufs Ziel. Der Wegpunkt bleibt
 *   stehen, die Fahrt geht auf der nächsten Stufe einfach weiter.
 */
export function helmCommand(
  profile: VesselProfile,
  motion: VesselMotion,
  waypoint: Waypoint | null,
  step: number,
): Command {
  const ordered = orderedSpeed(profile, step);

  if (!waypoint || ordered < 0) {
    return { throttle: throttleFor(profile, motion.speed, ordered), rudder: 0 };
  }

  return autopilot(profile, motion, waypoint, ordered);
}
