/**
 * Fahrleistung eines Fahrzeugtyps. Alle Längen in Weltunits (1 Unit = 1 Meter),
 * alle Winkel in Grad.
 *
 * Die konkreten Werte liegen bewusst NICHT hier, sondern in der Config der
 * jeweiligen Anwendung — nur der Vertrag ist geteilt.
 */
export interface VesselProfile {
  /** Höchstfahrt voraus in m/s. */
  maxForward: number;
  /** Höchstfahrt zurück in m/s, negativ. */
  maxReverse: number;
  /** Beschleunigung in m/s². */
  accel: number;
  /** Verzögerung unter Gegenschub in m/s². */
  brake: number;
  /** Passives Ausrollen bei Maschine Stopp in m/s². */
  drag: number;
  /** Taktischer Wendekreisradius bei voller Fahrt in Metern. */
  turnRadius: number;
  /** Manövrierdüse: fahrtunabhängige Drehrate in Grad/s. */
  thrusterRate: number;
  /** Harte Obergrenze der Drehrate in Grad/s. */
  maxTurnRate: number;
  /** Kursfehler in Grad, ab dem das Ruder voll ausschlägt. */
  rudderAuthority: number;
  /** Restdistanz in Metern, ab der ein Wegpunkt als erreicht gilt. */
  arriveRadius: number;
}

/** Veränderlicher Bewegungszustand. Wird von `stepVessel` in-place fortgeschrieben. */
export interface VesselMotion {
  x: number;
  y: number;
  /** Kurs in Grad. 0 = Norden, im Uhrzeigersinn. */
  rotation: number;
  /** Fahrt in m/s. Negativ bedeutet Rückwärtsfahrt. */
  speed: number;
}

export interface Waypoint {
  x: number;
  y: number;
}

/** Steuerbefehl — dasselbe, was der Client später als `InputMessage` schickt. */
export interface Command {
  /** -1 = volle Kraft zurück, 0 = Maschine stopp, 1 = volle Kraft voraus. */
  throttle: number;
  /** -1 = Ruder hart backbord, 0 = mittschiffs, 1 = hart steuerbord. */
  rudder: number;
}
