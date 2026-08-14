/**
 * Torus-Geometrie der Endlos-Karte: wer rechts hinausfährt, kommt links
 * wieder herein. Die Karte hat damit KEINEN Rand mehr — jede Distanz- und
 * Richtungsrechnung zwischen zwei Punkten muss den kürzesten Weg über die
 * Naht berücksichtigen, sonst ist ein Gegner direkt hinter der Naht
 * „24 km entfernt".
 */

/**
 * Kürzester Versatz von `from` nach `to` auf einem Ring der Länge `size`.
 * Ergebnis in (−size/2, size/2]. Robust gegen Werte außerhalb von [0, size).
 */
export function torusDelta(from: number, to: number, size: number): number {
  const halb = size / 2;
  let d = (to - from) % size;
  if (d > halb) d -= size;
  else if (d < -halb) d += size;
  return d;
}

/** Koordinate in [0, size) einpassen. */
export function wrapCoord(value: number, size: number): number {
  return ((value % size) + size) % size;
}

/** Quadrat des kürzesten Abstands zweier Punkte auf dem Torus. */
export function torusDistanceSquared(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  width: number,
  height: number,
): number {
  const dx = torusDelta(ax, bx, width);
  const dy = torusDelta(ay, by, height);
  return dx * dx + dy * dy;
}
