import { DEG, angleDelta, bearing, clamp, norm360 } from './angles.js';
import type { Command, VesselMotion, VesselProfile, Waypoint } from './VesselProfile.js';

/**
 * Fahrmodell für Schiffe und U-Boote.
 *
 * Reine Funktionen über flache Daten: kein Modulzustand, kein `Date.now()`,
 * kein `Math.random()`. Client und Server können damit denselben Code fahren —
 * die Voraussetzung für spätere Client-Prediction.
 */

/**
 * Erreichbare Drehrate in Grad/s bei gegebener Fahrt.
 *
 * Der Term `speed / turnRadius` hält den WENDEKREIS konstant und macht die
 * DREHRATE fahrtabhängig — ein stehendes Boot dreht dadurch praktisch nicht,
 * ohne dass man diesen Sonderfall extra behandeln müsste.
 */
export function maxTurnRate(profile: VesselProfile, speed: number): number {
  const fromRudder = Math.abs(speed) / profile.turnRadius / DEG;
  return Math.min(profile.maxTurnRate, fromRudder + profile.thrusterRate);
}

/**
 * Höchste Fahrt, mit der ein Kreis vom Radius `requiredRadius` noch gefahren
 * werden kann.
 */
export function speedForRadius(profile: VesselProfile, requiredRadius: number): number {
  // Negierter Vergleich mit Absicht: fängt Infinity (Ziel genau voraus) und NaN
  // in derselben Zeile ab, bevor durch (1 - r/R) geteilt wird.
  if (!(requiredRadius < profile.turnRadius)) return profile.maxForward;

  const thruster = profile.thrusterRate * DEG;
  return Math.max(0, (requiredRadius * thruster) / (1 - requiredRadius / profile.turnRadius));
}

export function distanceTo(motion: VesselMotion, waypoint: Waypoint): number {
  return Math.hypot(waypoint.x - motion.x, waypoint.y - motion.y);
}

export function hasArrived(profile: VesselProfile, motion: VesselMotion, waypoint: Waypoint): boolean {
  return distanceTo(motion, waypoint) <= profile.arriveRadius;
}

/**
 * Rechnet einen Wegpunkt in einen Steuerbefehl um.
 *
 * Das ist die Naht, die den Autopiloten von der Physik trennt: eine spätere
 * manuelle Ruderlage erzeugt denselben `Command` und läuft durch dasselbe
 * `stepVessel`. Es gibt also nie zwei Bewegungssysteme.
 */
export function autopilot(
  profile: VesselProfile,
  motion: VesselMotion,
  waypoint: Waypoint,
  orderedSpeed: number = profile.maxForward,
): Command {
  const dx = waypoint.x - motion.x;
  const dy = waypoint.y - motion.y;
  const distance = Math.hypot(dx, dy);
  const courseError = angleDelta(motion.rotation, bearing(dx, dy));

  // Bremsweg aus v² = 2*a*s. Der arriveRadius steht INNERHALB der Wurzel,
  // sonst kriecht das Boot die letzten Meter mit Schrittgeschwindigkeit.
  const brakingSpeed = Math.sqrt(Math.max(0, 2 * profile.brake * (distance - profile.arriveRadius)));

  // Bei großem Kursfehler drosseln — sonst schießt das Boot am Ziel vorbei,
  // bevor es überhaupt eingedreht hat.
  const turnSpeed = profile.maxForward * clamp(Math.cos(courseError * DEG), 0.03, 1);

  // Geometrische Grenze. Der Kreis durch die aktuelle Position, der das Ziel auf
  // dem Rand hat, misst d² / (2 * Querabstand). Ist der kleiner als der eigene
  // Wendekreis, MUSS langsamer gefahren werden — ohne diese Zeile umkreist das
  // Boot ein nahes Querziel endlos, statt es zu erreichen.
  const lateral = Math.abs(distance * Math.sin(courseError * DEG));
  const requiredRadius = lateral > 1e-6 ? (distance * distance) / (2 * lateral) : Infinity;
  const geometrySpeed = speedForRadius(profile, requiredRadius);

  const targetSpeed = Math.min(brakingSpeed, turnSpeed, geometrySpeed, orderedSpeed);

  return {
    throttle: throttleFor(profile, motion.speed, targetSpeed),
    rudder: clamp(courseError / profile.rudderAuthority, -1, 1),
  };
}

/**
 * Hebelstellung, die `targetSpeed` erreicht und hält.
 *
 * Der erste Term ist eine Vorsteuerung, der zweite eine Korrektur. Die
 * Vorsteuerung ist nicht optional: `stepVessel` liest die Hebelstellung als
 * ABSOLUTE Wunschfahrt, ein reiner Korrekturterm schließt den Kreis deshalb bei
 * `ziel · 10/11` — jede befohlene Stufe bliebe dauerhaft rund 9 % darunter.
 */
export function throttleFor(
  profile: VesselProfile,
  currentSpeed: number,
  targetSpeed: number,
): number {
  const span = targetSpeed >= 0 ? profile.maxForward : Math.abs(profile.maxReverse);
  const feedForward = span > 0 ? targetSpeed / span : 0;
  const correction = (targetSpeed - currentSpeed) / (profile.maxForward * 0.1);
  return clamp(feedForward + correction, -1, 1);
}

/**
 * Ein Simulationsschritt. Mutiert `motion` absichtlich in-place — eine spätere
 * Reconciliation rechnet damit hunderte Schritte pro Sekunde nach.
 *
 * `dt` muss ein FESTER Zeitschritt sein. Das Modell ist nichtlinear (die
 * Drehrate hängt von der Fahrt ab, die Bremskurve von einer Wurzel), mit
 * variablen Schritten wäre es nicht reproduzierbar.
 */
export function stepVessel(
  profile: VesselProfile,
  motion: VesselMotion,
  command: Command,
  dt: number,
): void {
  const throttle = clamp(command.throttle, -1, 1);
  const rudder = clamp(command.rudder, -1, 1);

  const desiredSpeed =
    throttle >= 0 ? throttle * profile.maxForward : Math.abs(throttle) * profile.maxReverse;
  const difference = desiredSpeed - motion.speed;

  let rate: number;
  if (Math.abs(throttle) < 0.02) {
    rate = profile.drag; // Maschine stopp: ausrollen, nicht bremsen
  } else {
    const speedingUp =
      Math.abs(desiredSpeed) > Math.abs(motion.speed) &&
      Math.sign(desiredSpeed) === Math.sign(motion.speed === 0 ? desiredSpeed : motion.speed);
    rate = speedingUp ? profile.accel : profile.brake;
  }

  const maxChange = rate * dt;
  motion.speed += clamp(difference, -maxChange, maxChange);

  // Rückwärts kehrt sich die Ruderwirkung um.
  const direction = motion.speed < 0 ? -1 : 1;
  const deltaHeading = maxTurnRate(profile, motion.speed) * rudder * direction * dt;

  // Mittelpunkt-Verfahren: halbe Drehung, fahren, andere Hälfte. Naives Euler
  // weicht bei 50-ms-Schritten pro 180°-Wende um rund 1,5 m vom exakten
  // Kreisbogen ab — mit Mittelpunkt bleibt ein Millimeter übrig.
  const midCourse = (motion.rotation + deltaHeading * 0.5) * DEG;
  motion.x += Math.sin(midCourse) * motion.speed * dt;
  motion.y += -Math.cos(midCourse) * motion.speed * dt;
  motion.rotation = norm360(motion.rotation + deltaHeading);
}
