import type { PlayerState, VesselModel } from '../types/Player.js';
import { DEFAULT_VESSEL_MODEL } from '../types/Player.js';
import { distanceTo, hasArrived, stepVessel } from './movement.js';
import { TELEGRAPH_CRUISE, TELEGRAPH_STOP, clampStep, helmCommand, orderedSpeed } from './telegraph.js';
import type { VesselMotion, VesselProfile, Waypoint } from './VesselProfile.js';

/** Dauer des vollen Tauch-/Auftauchwegs in Sekunden. */
export const DIVE_SECONDS = 5;

/** Dauer des Periskop-Aus-/Einfahrens in Sekunden. */
export const PERISCOPE_SECONDS = 3;

export interface VesselInit {
  id: string;
  name: string;
  x: number;
  y: number;
  rotation: number;
  model?: VesselModel;
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
  /** Schiffsmodell — rein visuell, die Fahrphysik hängt am Profil. */
  model: VesselModel;
  x: number;
  y: number;
  rotation: number;
  speed = 0;

  waypoint: Waypoint | null = null;
  /** Rast des Maschinentelegrafen. Startstellung ist „Maschine stopp". */
  telegraphStep = TELEGRAPH_STOP;

  /** Tauchtiefe 0..1. Läuft in `simulate` auf `diveTarget` zu. */
  depth = 0;
  /** Gewollter Tauchzustand. Setzen nur über `orderDive`. */
  diveTarget = false;

  /** Periskop-Ausfahrstand 0..1. Läuft in `simulate` auf `periscopeTarget` zu. */
  periscope = 0;
  /** Gewollter Periskop-Zustand. Setzen nur über `orderPeriscope`. */
  periscopeTarget = false;

  private profile: VesselProfile;
  /** Wie oft der Wegpunkt seit dem letzten Befehl neu gesetzt wurde. */
  private orderSerial = 0;
  private closestApproach = Number.POSITIVE_INFINITY;
  private stalledFor = 0;

  constructor(init: VesselInit, profile: VesselProfile) {
    this.id = init.id;
    this.name = init.name;
    this.model = init.model ?? DEFAULT_VESSEL_MODEL;
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

  /**
   * Tauscht das Fahrprofil — beim Modellwechsel (Dev-Menü) fährt das Boot ab
   * dem nächsten Simulationsschritt mit den Werten des neuen Schiffs.
   */
  applyProfile(profile: VesselProfile): void {
    this.profile = profile;
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

  /**
   * Tauchbefehl. Auch mitten im Übergang umkehrbar — die Tiefe läuft dann
   * einfach in die andere Richtung. Ob dieses Schiff überhaupt tauchen darf,
   * entscheidet der Aufrufer (Server, gegen den Schiffskatalog).
   */
  orderDive(submerged: boolean): void {
    this.diveTarget = submerged;
  }

  /** Periskop-Befehl — gleiche Logik wie `orderDive`, eigener Antrieb. */
  orderPeriscope(extended: boolean): void {
    this.periscopeTarget = extended;
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

    // Tauchvorgang: fünf Sekunden für den vollen Weg, linear und in beide
    // Richtungen — ein Gegenbefehl mitten im Übergang kehrt einfach um.
    const zielTiefe = this.diveTarget ? 1 : 0;
    if (this.depth !== zielTiefe) {
      const schritt = (dt / DIVE_SECONDS) * (zielTiefe > this.depth ? 1 : -1);
      this.depth = Math.min(Math.max(this.depth + schritt, 0), 1);
    }

    // Periskop: drei Sekunden, sonst dieselbe Mechanik wie das Tauchen.
    const zielPeriskop = this.periscopeTarget ? 1 : 0;
    if (this.periscope !== zielPeriskop) {
      const schritt = (dt / PERISCOPE_SECONDS) * (zielPeriskop > this.periscope ? 1 : -1);
      this.periscope = Math.min(Math.max(this.periscope + schritt, 0), 1);
    }

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
      model: this.model,
      x: this.x,
      y: this.y,
      rotation: this.rotation,
      speed: this.speed,
      depth: this.depth,
      periscope: this.periscope,
    };
  }

  /**
   * Übernimmt einen Serverzustand. Auf dem Client tritt das an die Stelle von
   * `simulate()` — dort wird nicht gerechnet, sondern nur dargestellt.
   */
  applyState(state: PlayerState): void {
    this.name = state.name;
    this.model = state.model;
    this.x = state.x;
    this.y = state.y;
    this.rotation = state.rotation;
    this.speed = state.speed;
    this.depth = state.depth;
    this.periscope = state.periscope;
  }

  /**
   * Übernimmt den Besitzer-Zustand aus dem `own`-Ereignis (Gegenstück zu
   * `applyState`, das nur die Broadcast-Felder trägt). Damit funktionieren
   * Wegpunkt-Marker, Telegrafenanzeige und das Einfrieren der Gesamtstrecke
   * über `serial` online unverändert — die Werte kommen nur vom Server statt
   * aus der eigenen Simulation.
   */
  applyOwnState(state: {
    telegraphStep: number;
    waypoint: Waypoint | null;
    diveTarget: boolean;
    periscopeTarget: boolean;
    serial: number;
  }): void {
    this.telegraphStep = state.telegraphStep;
    this.waypoint = state.waypoint ? { ...state.waypoint } : null;
    this.diveTarget = state.diveTarget;
    this.periscopeTarget = state.periscopeTarget;
    this.orderSerial = state.serial;
  }
}
