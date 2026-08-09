/** Grad -> Radiant. */
export const DEG = Math.PI / 180;

/** Normalisiert einen Winkel auf [0, 360). */
export function norm360(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Kürzeste Drehung von `from` nach `to`, Ergebnis in (-180, 180].
 * Ohne das dreht ein Boot bei jedem Durchgang über 359°/1° einmal komplett
 * um die eigene Achse.
 */
export function angleDelta(from: number, to: number): number {
  const diff = norm360(to - from);
  return diff > 180 ? diff - 360 : diff;
}

/**
 * Peilung eines Richtungsvektors in Grad. 0 = Norden, im Uhrzeigersinn.
 *
 * Bewusst `atan2(dx, -dy)` und nicht das übliche `atan2(dy, dx)`: in dieser
 * Welt zeigt x nach Osten, y nach Süden, und 0° ist Norden.
 */
export function bearing(dx: number, dy: number): number {
  return norm360((Math.atan2(dx, -dy) * 180) / Math.PI);
}

/** Einheitsvektor eines Kurses. Gegenstück zu `bearing`. */
export function headingVector(degrees: number): { x: number; y: number } {
  const radians = degrees * DEG;
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
