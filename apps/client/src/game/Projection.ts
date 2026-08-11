import { Matrix, Point } from 'pixi.js';
import { VIEW } from '../config';

/**
 * Welt -> Bildschirm, ohne Kamera und ohne Zoom.
 *
 * Bewusst genau eine affine 3x3-Matrix. Das hat zwei Gründe: die Umkehrung
 * bleibt exakt (Maus -> Weltkoordinate über dieselbe Matrix), und der Wechsel
 * der Darstellungsart ist ein Zahlentausch statt eines Umbaus:
 *
 *   flach von oben    new Matrix(1, 0,   0,  1)
 *   gekippt (aktiv)   new Matrix(1, 0,   0,  tilt)
 *   isometrisch 2:1   new Matrix(1, 0.5, -1, 0.5)
 *
 * Echte Perspektive ginge damit NICHT — die ist nicht affin und würde Picking,
 * Culling und HUD-Anker mitreißen.
 *
 * Die Matrix wird bei `setTilt` IN PLACE geändert. Alle Stellen, die sie pro
 * Frame kopieren (`World.applyCamera`), ziehen dadurch automatisch nach — es
 * gibt keine zweite Quelle, die man vergessen könnte.
 */
export const PROJECTION = new Matrix(1, 0, 0, VIEW.tilt);

// Explizit `number`: `VIEW` ist `as const`, sonst wäre der Typ das Literal
// des Startwerts und `setTilt` könnte nichts anderes zuweisen.
let currentTilt: number = VIEW.tilt;

/**
 * Aktuelle vertikale Stauchung.
 *
 * Geometrisch ist das `sin(Höhenwinkel der Kamera über dem Horizont)`:
 * 1.0 = senkrecht von oben, 0.55 = 33,4°, 0.42 = 24,8°.
 */
export function getTilt(): number {
  return currentTilt;
}

export function setTilt(value: number): void {
  currentTilt = Math.min(Math.max(value, VIEW.minTilt), 1);
  PROJECTION.set(1, 0, 0, currentTilt, 0, 0);
}

/**
 * Lokaler y-Versatz pro Meter Höhe für Dinge, die SENKRECHT auf der Wasserebene
 * stehen — Türme, Masten, Aufbauten.
 *
 * Der Wert ist um `1/tilt` vorkompensiert, weil der gekippte Layer anschließend
 * noch staucht. Bei tilt 0.55 sind das -1,5185 statt der reinen -0,8352.
 *
 * ⚠️ Gilt NICHT für Schatten: die liegen IN der Wasserebene und werden vom
 * Layer von selbst korrekt gestaucht. Wer beide Regeln gleich behandelt,
 * bekommt einen Fehler, der wie ein Kalibrierungsproblem aussieht.
 */
export function heightOffsetPerMetre(): number {
  return -Math.sqrt(1 - currentTilt ** 2) / currentTilt;
}

/**
 * Kamerahöhe der Turntable-Renders (Dateiname `View_x°___50°`) als Stauchung.
 * Alle Fahrzeug- und Projektil-Atlanten sind bei 50° über dem Horizont
 * gerendert; ihre Bilder tragen diese Verkürzung also bereits in sich.
 */
export const RENDER_ELEVATION = Math.sin((50 * Math.PI) / 180);

/**
 * Bildschirmwinkel (0 = nach oben, im Uhrzeigersinn, Radiant) einer
 * Weltrichtung, deren y-Anteil mit `squash` gestaucht dargestellt wird.
 *
 * ⚠️ Der Zusammenhang ist NICHT linear, und genau daran ist die
 * Billboard-Drehung gescheitert: eine Azimut-Stufe von 5,625° (eine der 64
 * Richtungen) dreht die scheinbare Rumpfachse im 50°-Render um 7,3°. Wer den
 * Restwinkel linear addiert, lässt an jeder Framegrenze rund 1,7° Sprung
 * stehen — gemessen ein Grad Ruck alle 0,7 Sekunden beim Drehen.
 */
export function screenAxisAngle(courseDegrees: number, squash: number): number {
  const course = courseDegrees * (Math.PI / 180);
  return Math.atan2(Math.sin(course), Math.cos(course) * squash);
}

/** Weltkoordinate in die (noch kamerafreie) Bildebene. */
export function project(x: number, y: number, out: Point = new Point()): Point {
  return PROJECTION.apply({ x, y }, out);
}

/** Umkehrung von `project`. */
export function unproject(x: number, y: number, out: Point = new Point()): Point {
  return PROJECTION.applyInverse({ x, y }, out);
}
