/**
 * Flottillen — Zusammenschlüsse von Kapitänen (das Clan-System des Spiels).
 *
 * V1 ist rein organisatorisch/optisch: Mitgliedschaft, Ränge, Kasse und
 * Statistik — keine Gameplay-Effekte. Die RECHTE-Helfer hier sind die einzige
 * Quelle der Wahrheit: api (durchsetzen) und Client (Knöpfe zeigen/verstecken)
 * rechnen mit denselben Funktionen, sonst laufen Anzeige und Ablehnung
 * auseinander.
 */

/** Ab diesem Spielstufen-Level steht der Flottillen-Bereich offen. */
export const FLEET_MIN_LEVEL = 5;

/**
 * Die fünf Flottillenränge — Zahl = Rangstufe, KLEINER ist HÖHER (1 = Gründer).
 * Die Reihenfolge ist Anzeige-Reihenfolge.
 */
export const FLEET_RANKS: ReadonlyArray<{ id: number; name: string }> = [
  { id: 1, name: 'Flottillenkommandant' },
  { id: 2, name: 'Stellv. Flottillenkommandant' },
  { id: 3, name: 'Stabsoffizier' },
  { id: 4, name: 'Bootskommandant' },
  { id: 5, name: 'Besatzungsmitglied' },
];

export const FLEET_RANK_LEADER = 1;
export const FLEET_RANK_MEMBER = 5;

export function fleetRankName(rank: number): string {
  return FLEET_RANKS.find((eintrag) => eintrag.id === rank)?.name ?? 'Besatzungsmitglied';
}

export function isFleetRank(value: unknown): value is number {
  return typeof value === 'number' && FLEET_RANKS.some((eintrag) => eintrag.id === value);
}

/** Mitgliederverwaltung (Ränge vergeben, entlassen): Kommandant, Stellvertreter, Stabsoffizier. */
export function canManageMembers(rank: number): boolean {
  return rank <= 3;
}

/** Verwaltung der Flottille selbst (Beschreibung, später Auflösen): Kommandant + Stellvertreter. */
export function canAdminFleet(rank: number): boolean {
  return rank <= 2;
}

/**
 * Darf `actor` das Mitglied `target` auf `newRank` setzen?
 *
 * Grundsatz: man verwaltet nur nach UNTEN — wer über einem steht (oder gleich),
 * ist tabu, und man vergibt keine Ränge auf oder über der eigenen Stufe. Die
 * einzige Ausnahme ist der Kommandant: er darf das Kommando ÜBERGEBEN (ein
 * Mitglied auf Rang 1 setzen) — die api stuft ihn dabei selbst auf Rang 2.
 */
export function canAssignRank(actor: number, target: number, newRank: number): boolean {
  if (!canManageMembers(actor)) return false;
  if (target <= actor) return false;
  if (actor === FLEET_RANK_LEADER) return true;
  return newRank > actor;
}

/** Darf `actor` das Mitglied `target` entlassen? Nur nach unten. */
export function canKick(actor: number, target: number): boolean {
  return canManageMembers(actor) && target > actor;
}

/* --- Namensregeln -------------------------------------------------------- */

export const FLEET_NAME_MIN = 3;
export const FLEET_NAME_MAX = 30;
export const FLEET_DESCRIPTION_MAX = 200;

/** Anzeige-Name säubern; null, wenn er den Regeln nicht genügt. */
export function normalizeFleetName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < FLEET_NAME_MIN || name.length > FLEET_NAME_MAX) return null;
  return name;
}

/* --- Wire-Typen ---------------------------------------------------------- */

/** Eintrag der Flottillen-Suche. */
export interface FleetSummary {
  id: string;
  name: string;
  description: string | null;
  members: number;
}

export interface FleetProfile {
  id: string;
  name: string;
  description: string | null;
  /** Kassenstand in Coins. */
  treasury: number;
  createdAt: string;
}

export interface FleetMemberEntry {
  accountId: string;
  displayName: string;
  /** Spielstufe des Mitglieds (aus dem XP-Stand abgeleitet). */
  level: number;
  /** Flottillenrang 1..5, 1 = Kommandant. */
  rank: number;
  joinedAt: string;
}

/** Antwort von „Meine Flottille": Profil plus komplette Mitgliederliste. */
export interface FleetMineResponse {
  fleet: FleetProfile;
  members: FleetMemberEntry[];
}
