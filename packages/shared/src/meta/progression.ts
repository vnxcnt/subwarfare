/**
 * Levelsystem und Ränge.
 *
 * Liegt in `shared`, weil beide Seiten dieselben Zahlen brauchen: der Server
 * vergibt XP und entscheidet über Levelaufstiege (er ist die Quelle der
 * Wahrheit), der Client zeigt Rang und Fortschritt an. Zwei Tabellen wären
 * irgendwann zwei Wahrheiten.
 *
 * Gespeichert wird NUR der XP-Gesamtstand — das Level wird daraus abgeleitet.
 * Ein zusätzliches Level-Feld in der Datenbank könnte dem XP-Stand
 * widersprechen und müsste bei jeder Kurven-Änderung migriert werden.
 */

/** Dienstgrade, Index = Level - 1. */
export const RANKS: readonly string[] = [
  'Decksmann',
  'Oberdecksmann',
  'Signalgast',
  'Steuergast',
  'Maschinengast',
  'Wachmaat',
  'Obermaat',
  'Steuermaat',
  'Maschinenmaat',
  'Bootsmeister',
  'Oberbootsmeister',
  'Leitoffizier',
  'Unterleutnant zur See',
  'Leutnant zur See',
  'Oberleutnant zur See',
  'Korvettenkapitän',
  'Fregattenkapitän',
  'Kapitän zur See',
  'Flottillenkommandeur',
  'Admiral der Flotte',
] as const;

export const MAX_LEVEL = RANKS.length;

/** XP für den ersten Aufstieg (Level 1 → 2). */
export const XP_BASE = 500;

/**
 * Wachstumsfaktor je Level — die geforderte exponentielle Steigung.
 *
 * 1,35 hält die Spanne fahrbar: Der letzte Aufstieg (19 → 20) kostet damit
 * 110.912 XP (das ~222-Fache des ersten), der Gesamtweg bis Level 20 liegt
 * bei 426.374 XP. Seit es XP-Vergabe gibt (XP_REWARDS in meta/stats.ts),
 * ist das keine freie Stellschraube mehr: eine Kurven-Änderung verschiebt
 * die Level aller Bestandskonten und braucht eine bewusste Entscheidung.
 */
export const XP_GROWTH = 1.35;

/**
 * Aufstiegskosten je Level, einmal vorberechnet: `steps[i]` = XP von
 * Level i+1 auf i+2. Gerundet, damit überall Ganzzahlen ankommen.
 */
const steps: readonly number[] = Array.from({ length: MAX_LEVEL - 1 }, (_, i) =>
  Math.round(XP_BASE * XP_GROWTH ** i),
);

/** Kumulierte XP, ab denen ein Level erreicht ist: `totals[0]` = 0 für Level 1. */
const totals: readonly number[] = steps.reduce<number[]>(
  (acc, step) => {
    acc.push((acc.at(-1) ?? 0) + step);
    return acc;
  },
  [0],
);

/** XP-Kosten für den Aufstieg VON `level` auf das nächste. 0 am Höchstlevel. */
export function xpForNextLevel(level: number): number {
  if (level >= MAX_LEVEL) return 0;
  return steps[Math.max(0, level - 1)] ?? 0;
}

/** Kumulierte XP, ab denen `level` erreicht ist. */
export function totalXpForLevel(level: number): number {
  const clamped = Math.min(Math.max(level, 1), MAX_LEVEL);
  return totals[clamped - 1] ?? 0;
}

export interface Progression {
  level: number;
  rank: string;
  /** XP innerhalb des laufenden Levels. */
  xpIntoLevel: number;
  /** Kosten des laufenden Aufstiegs. 0 am Höchstlevel. */
  xpForNext: number;
  /** 0..1 — am Höchstlevel konstant 1. */
  progress: number;
}

/** Leitet Level, Rang und Fortschritt aus dem XP-Gesamtstand ab. */
export function progressionFromXp(xp: number): Progression {
  const safe = Number.isFinite(xp) ? Math.max(0, Math.floor(xp)) : 0;

  let level = 1;
  while (level < MAX_LEVEL && safe >= (totals[level] ?? Infinity)) level += 1;

  const xpIntoLevel = safe - (totals[level - 1] ?? 0);
  const xpForNext = xpForNextLevel(level);

  return {
    level,
    rank: RANKS[level - 1] ?? RANKS[0]!,
    xpIntoLevel,
    xpForNext,
    progress: level >= MAX_LEVEL ? 1 : Math.min(xpIntoLevel / xpForNext, 1),
  };
}
