import type { PlayerState } from '../types/Player.js';
import { distanceTo, hasArrived, stepVessel } from './movement.js';
import { TELEGRAPH_CRUISE, TELEGRAPH_STOP, clampStep, helmCommand, orderedSpeed } from './telegraph.js';
import type { VesselMotion, VesselProfile, Waypoint } from './VesselProfile.js';

export interface VesselInit {
  id: string;
  name: string;
  x: number;
  y: number;
  rotation: number;
}

/**
 * Ein Fahrzeug als reines Datenmodell — ohne PixiJS, ohne DOM.
 *
 * Liegt in `shared`, weil beide Seiten es brauchen, aber mit
 * unterschiedlicher Rolle:
 * - **Server:** ruft `simulate(dt)` und ist damit die Quelle der Wahrheit.
 * - **Client:** ruft `applyState()` mit dem, was über das Netz kommt, und
 *   rendert nur. `simulate()` nutzt er ausschließlich im Offline-Demobetrieb.
 */
export class Vessel implements VesselMotion {
  readonly id: string;
  name: string;
  x: number;
  y: number;
  rotation: number;
  speed = 0;

  waypoint: Waypoint | null = null;
  /** Rast des Maschinentelegrafen. Startstellung ist „Maschine stopp". */
  telegraphStep = TELEGRAPH_STOP;

  private readonly profile: VesselProfile;
  /** Wie oft der Wegpunkt seit dem letzten Befehl neu gesetzt wurde. */
  private orderSerial = 0;
  private closestApproach = Number.POSITIVE_INFINITY;
  private stalledFor = 0;

  constructor(init: VesselInit, profile: VesselProfile) {
    this.id = init.id;
    this.name = init.name;
    this.x = init.x;
    this.y = init.y;
    this.rotation = init.rotation;
    this.profile = profile;
  }

  /** Steigt bei jedem neuen Befehl — die Ansicht erkennt daran den Ping. */
  get serial(): number {
    return this.orderSerial;
  }

  get distanceToWaypoint(): number | null {
    return this.waypoint ? distanceTo(this, this.waypoint) : null;
  }

  /** Befohlene Fahrt in m/s. Negativ bedeutet Rückwärtsfahrt. */
  get orderedSpeed(): number {
    return orderedSpeed(this.profile, this.telegraphStep);
  }

  get maxForward(): number {
    return this.profile.maxForward;
  }

  /** Ortungsreichweite des eigenen Sonars in Metern. */
  get sensorRange(): number {
    return this.profile.sensorRange;
  }

  orderMoveTo(x: number, y: number): void {
    this.waypoint = { x, y };
    this.orderSerial += 1;
    this.closestApproach = Number.POSITIVE_INFINITY;
    this.stalledFor = 0;

    // Ein Fahrbefehl bei stehender oder rückwärts laufender Maschine bliebe
    // sonst wirkungslos — der Spieler klickt und nichts passiert.
    if (this.telegraphStep <= TELEGRAPH_STOP) this.telegraphStep = TELEGRAPH_CRUISE;
  }

  clearOrder(): void {
    this.waypoint = null;
  }

  setTelegraph(step: number): void {
    this.telegraphStep = clampStep(step);
    // Rückwärts ist ein Handmanöver. Einen Wegpunkt rückwärts anzusteuern ergibt
    // keinen Sinn, also gilt er als widerrufen.
    if (this.telegraphStep < TELEGRAPH_STOP) this.clearOrder();
  }

  simulate(dt: number): void {
    stepVessel(
      this.profile,
      this,
      helmCommand(this.profile, this, this.waypoint, this.telegraphStep),
      dt,
    );

    if (!this.waypoint) return;

    if (hasArrived(this.profile, this, this.waypoint)) {
      this.clearOrder();
      // Ohne das beschleunigt das Boot nach der Ankunft wieder auf die befohlene
      // Stufe und fährt geradeaus davon — „angekommen" heißt Maschine stopp.
      this.telegraphStep = TELEGRAPH_STOP;
      return;
    }

    // Bei stehender Maschine bleibt der Wegpunkt absichtlich liegen; der
    // Wachhund darf ihn dann nicht als unerreichbar verwerfen.
    if (this.orderedSpeed <= 0) return;

    // Wachhund: kommt das Boot acht Sekunden lang nicht näher, ist der Wegpunkt
    // unerreichbar. Die geometrische Fahrtbegrenzung im Autopiloten deckt den
    // Kreisel-Fall ab, aber nicht Kollisionen, Kartenränder oder Strömung, die
    // später dazukommen.
    const distance = distanceTo(this, this.waypoint);
    if (distance < this.closestApproach - 0.5) {
      this.closestApproach = distance;
      this.stalledFor = 0;
    } else {
      this.stalledFor += dt;
      if (this.stalledFor > 8) this.clearOrder();
    }
  }

  /**
   * Zustand für den Broadcast.
   *
   * Bewusst OHNE Wegpunkt und Telegrafenstufe: die verraten die Absicht und
   * gehen nur an den Besitzer selbst (`own`-Ereignis).
   */
  toState(): PlayerState {
    return {
      id: this.id,
      name: this.name,
      x: this.x,
      y: this.y,
      rotation: this.rotation,
      speed: this.speed,
    };
  }

  /**
   * Übernimmt einen Serverzustand. Auf dem Client tritt das an die Stelle von
   * `simulate()` — dort wird nicht gerechnet, sondern nur dargestellt.
   */
  applyState(state: PlayerState): void {
    this.name = state.name;
    this.x = state.x;
    this.y = state.y;
    this.rotation = state.rotation;
    this.speed = state.speed;
  }

  /**
   * Übernimmt den Besitzer-Zustand aus dem `own`-Ereignis (Gegenstück zu
   * `applyState`, das nur die Broadcast-Felder trägt). Damit funktionieren
   * Wegpunkt-Marker, Telegrafenanzeige und das Einfrieren der Gesamtstrecke
   * über `serial` online unverändert — die Werte kommen nur vom Server statt
   * aus der eigenen Simulation.
   */
  applyOwnState(state: { telegraphStep: number; waypoint: Waypoint | null; serial: number }): void {
    this.telegraphStep = state.telegraphStep;
    this.waypoint = state.waypoint ? { ...state.waypoint } : null;
    this.orderSerial = state.serial;
  }
}
