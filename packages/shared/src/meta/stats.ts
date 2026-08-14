/**
 * Statistik: XP-Belohnungen, Kampf-Ereignisse und Bestenlisten-Wire-Typen.
 *
 * Liegt in `shared`, weil drei Seiten dieselben Begriffe brauchen: der
 * Spielserver MELDET Ereignisse (nur Typen, nie Beträge), die api RECHNET
 * daraus XP und Zähler, der Client ZEIGT die Bestenlisten an. Die Beträge
 * stehen ausschließlich hier — der Meldeweg kann nie falsche Zahlen tragen.
 */

/** XP-Belohnungen — zentrale Stellschrauben, die api rechnet damit. */
export const XP_REWARDS = {
  /** Versenkter Spieler (nur wenn Opfer UND Killer Spieler sind). */
  playerKill: 150,
  /** Versenkter NPC (Bot oder Frachter). */
  npcKill: 30,
  /** Erfolgreiche Extraktion — nicht der Server-Shutdown. */
  extraction: 50,
} as const;

/**
 * Ereignis, wie der Spielserver es an `POST /api/internal/stats` meldet.
 * `pvp_kill` trägt beide Seiten: die api bucht daraus Kill UND Death —
 * „Death nur bei Spieler-Killer" ist damit strukturell erzwungen.
 */
export type StatsEvent =
  | { type: 'pvp_kill'; killerId: string; victimId: string }
  | { type: 'npc_kill'; accountId: string }
  | { type: 'extraction'; accountId: string };

export interface PvpLeaderboardEntry {
  accountId: string;
  displayName: string;
  level: number;
  kills: number;
  deaths: number;
}

export interface XpLeaderboardEntry {
  accountId: string;
  displayName: string;
  level: number;
  xp: number;
}

/** Antwort von `GET /api/stats/leaderboard`. */
export interface StatsLeaderboardResponse {
  /** Nach Kills sortiert; nur Konten mit Gefechtsberührung. */
  pvp: PvpLeaderboardEntry[];
  /** Nach XP sortiert; nur Konten mit xp > 0. */
  xp: XpLeaderboardEntry[];
}

export const LEADERBOARD_LIMIT = 20;
