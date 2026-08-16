/**
 * Polygon-Geometrie für Landmassen.
 *
 * Server (Kollision, Geschosse) und Client (Minimap, Klickauswahl) rechnen mit
 * DENSELBEN Funktionen — eine zweite Implementierung wäre eine zweite Wahrheit,
 * und die Folge wären Schiffe, die sichtbar im Sand stehen, ohne aufzulaufen.
 *
 * Alle Funktionen arbeiten in der gewöhnlichen Ebene, NICHT auf dem Torus:
 * Inseln dürfen die Naht nicht überqueren (siehe `Island`).
 */

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type Punkt = { x: number; y: number };

/** Achsenparallele Hülle — Vorfilter vor jeder teureren Prüfung. */
export function polygonBounds(polygon: readonly Punkt[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Liegt der Punkt innerhalb der Hülle (mit Spielraum)? */
export function inBounds(bounds: Bounds, x: number, y: number, spielraum = 0): boolean {
  return (
    x >= bounds.minX - spielraum &&
    x <= bounds.maxX + spielraum &&
    y >= bounds.minY - spielraum &&
    y <= bounds.maxY + spielraum
  );
}

/**
 * Punkt-in-Polygon nach dem Strahlensatz (ungerade Zahl an Kreuzungen = innen).
 * Punkte exakt auf der Kante gelten als innen oder außen — bei Landmassen ist
 * das ohne Belang, dort entscheidet ohnehin der Abstand mit Rumpfradius.
 */
export function pointInPolygon(polygon: readonly Punkt[], x: number, y: number): boolean {
  let innen = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      innen = !innen;
    }
  }
  return innen;
}

/** Quadrierter Abstand eines Punktes zur Strecke a→b. */
export function pointSegmentDistanceSquared(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const laenge = dx * dx + dy * dy;
  let t = laenge > 0 ? ((px - ax) * dx + (py - ay) * dy) / laenge : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/** Kürzester Abstand eines Punktes zur Polygon-KANTE, immer ≥ 0. */
export function distanceToPolygonEdge(
  polygon: readonly Punkt[],
  x: number,
  y: number,
): number {
  let besser = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const d = pointSegmentDistanceSquared(x, y, a.x, a.y, b.x, b.y);
    if (d < besser) besser = d;
  }
  return Math.sqrt(besser);
}

/**
 * Vorzeichenbehafteter Abstand: NEGATIV an Land (innerhalb), POSITIV auf dem
 * Wasser. Dieselbe Vorzeichen-Regel wie das gebackene Abstandsfeld des
 * Küsten-Shaders — damit bedeutet „Abstand < 0" überall im Projekt dasselbe.
 */
export function signedDistanceToPolygon(
  polygon: readonly Punkt[],
  x: number,
  y: number,
): number {
  const d = distanceToPolygonEdge(polygon, x, y);
  return pointInPolygon(polygon, x, y) ? -d : d;
}

/** Schneiden sich die Strecken a→b und c→d? */
export function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const r1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const r2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const r3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const r4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return r1 * r2 < 0 && r3 * r4 < 0;
}

/**
 * Trifft eine Strecke die Landmasse? Deckt beide Fälle ab: die Strecke kreuzt
 * die Küste, ODER sie verläuft vollständig im Inneren (dann kreuzt sie keine
 * Kante). Das ist der Test für Geschosse und später für Sichtverdeckung.
 */
export function segmentHitsPolygon(
  polygon: readonly Punkt[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const p = polygon[i]!;
    const q = polygon[j]!;
    if (segmentsIntersect(ax, ay, bx, by, p.x, p.y, q.x, q.y)) return true;
  }
  return pointInPolygon(polygon, ax, ay);
}

/**
 * Überlappt eine KAPSEL (Strecke a→b, verdickt um `radius`) die Landmasse?
 * Genau die Rumpfform, mit der schon Schiff-gegen-Schiff kollidiert — damit
 * läuft ein Zerstörer auf, wo auch ein zweiter Zerstörer ihn rammen würde.
 */
export function capsuleHitsPolygon(
  polygon: readonly Punkt[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
): boolean {
  if (segmentHitsPolygon(polygon, ax, ay, bx, by)) return true;
  if (radius <= 0) return false;
  const grenze = radius * radius;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const p = polygon[i]!;
    const q = polygon[j]!;
    // Abstand Strecke↔Strecke: bei sich NICHT schneidenden Strecken (oben schon
    // geprüft) ist es das Minimum der vier Punkt-zu-Strecke-Abstände.
    const d = Math.min(
      pointSegmentDistanceSquared(p.x, p.y, ax, ay, bx, by),
      pointSegmentDistanceSquared(q.x, q.y, ax, ay, bx, by),
      pointSegmentDistanceSquared(ax, ay, p.x, p.y, q.x, q.y),
      pointSegmentDistanceSquared(bx, by, p.x, p.y, q.x, q.y),
    );
    if (d <= grenze) return true;
  }
  return false;
}
