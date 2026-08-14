import type { AccountProfile, PvpLeaderboardEntry, XpLeaderboardEntry } from '@subwarfare/shared';

/**
 * Konto, wie es intern vorliegt — mit Feldern, die nie nach außen gehen.
 * `hasGoogle`/`hasDiscord` sind hier ausgenommen: intern gibt es die echten
 * Identitäten, die Anzeige-Flags leitet `toProfile` daraus ab.
 */
export interface Account extends Omit<AccountProfile, 'hasGoogle' | 'hasDiscord'> {
  /** Googles unveränderliche Nutzerkennung. `null`, wenn nicht verknüpft. */
  googleSub: string | null;
  /** Discords Snowflake-ID. `null`, wenn nicht verknüpft. */
  discordId: string | null;
  email: string | null;
  /** Kontorolle: 0 Spieler, 1 Moderator, 2 Gamemaster, 3 Entwickler. */
  role: number;
  lastLoginAt: string;
  /** PvP-Zähler — nur Spieler-gegen-Spieler, NPC-Abschüsse zählen nicht. */
  kills: number;
  deaths: number;
}

export interface GoogleIdentity {
  googleSub: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
}

export interface DiscordIdentity {
  discordId: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Konten-Ablage.
 *
 * Durchgehend `async`, obwohl die Speicher-Variante sofort antworten könnte:
 * Die Schnittstelle soll sich beim Wechsel auf MariaDB nicht ändern, und ein
 * nachträgliches Umstellen von synchron auf asynchron zieht sich durch jeden
 * Aufrufer.
 */
export interface AccountStore {
  /** Legt bei erster Anmeldung an, sonst aktualisiert es Name und Bild. */
  upsertGoogle(identity: GoogleIdentity): Promise<Account>;
  /** Wie `upsertGoogle`, nur am Discord-Konto festgemacht. */
  upsertDiscord(identity: DiscordIdentity): Promise<Account>;
  /** Entwickler-Login: Konto am Anzeigenamen festgemacht. */
  upsertDev(displayName: string): Promise<Account>;
  byId(id: string): Promise<Account | null>;
  /**
   * Namenssuche (Teiltreffer, Groß-/Kleinschreibung egal) — die Spielersuche
   * im Funkraum. Liefert höchstens `limit` Konten, alphabetisch.
   */
  searchByName(query: string, limit: number): Promise<Account[]>;
  touchLogin(id: string): Promise<void>;
  /**
   * Zieht Coins ab, aber nur wenn das Guthaben reicht — Prüfung und Abzug in
   * EINEM Schritt, sonst könnten zwei gleichzeitige Käufe dasselbe Guthaben
   * doppelt ausgeben. `false` = zu wenig Coins, nichts abgebucht.
   */
  spendCoins(id: string, amount: number): Promise<boolean>;
  /** Schreibt Coins gut — Erstattungen und (später) Belohnungen. */
  addCoins(id: string, amount: number): Promise<void>;
  /** Schreibt XP gut — Abzug gibt es nicht, XP sind monoton. */
  addXp(id: string, amount: number): Promise<void>;
  /** PvP-Abschuss des Kontos (+1 kills). Nur Spieler-gegen-Spieler. */
  recordPvpKill(id: string): Promise<void>;
  /** PvP-Untergang des Kontos (+1 deaths). Nur wenn der Killer ein Spieler war. */
  recordPvpDeath(id: string): Promise<void>;
  /**
   * Bestenlisten, absteigend sortiert (PvP nach Kills, XP nach Stand) und
   * bereits als Wire-Typen inklusive abgeleitetem Level. Konten ohne
   * Gefechtsberührung bzw. ohne XP tauchen nicht auf — eine Bestenliste aus
   * Nullzeilen sagt nichts und leakt nebenbei die komplette Kontoliste.
   */
  topPvp(limit: number): Promise<PvpLeaderboardEntry[]>;
  topXp(limit: number): Promise<XpLeaderboardEntry[]>;
  /**
   * Löscht das Konto endgültig — samt allem, was daran hängt (Inventar,
   * Ausrüstung, Dev-Verknüpfung; in MariaDB über die CASCADE-Fremdschlüssel).
   */
  deleteAccount(id: string): Promise<void>;
  /**
   * Hängt eine Google-Identität an ein BESTEHENDES Konto (Einstellungen →
   * „verknüpfen"). 'taken' = die Identität gehört bereits einem anderen
   * Konto (bewusst KEIN Merge — zwei Spielstände lassen sich nicht ehrlich
   * vereinen), 'conflict' = dieses Konto trägt bereits eine andere
   * Google-Identität.
   */
  linkGoogle(id: string, identity: GoogleIdentity): Promise<LinkResult>;
  /** Wie `linkGoogle`, nur für Discord. */
  linkDiscord(id: string, identity: DiscordIdentity): Promise<LinkResult>;
  close(): Promise<void>;
}

export type LinkResult = 'ok' | 'taken' | 'conflict';

export function toProfile(account: Account): AccountProfile {
  return {
    id: account.id,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    isDev: account.isDev,
    coins: account.coins,
    xp: account.xp,
    role: account.role,
    createdAt: account.createdAt,
    hasGoogle: account.googleSub !== null,
    hasDiscord: account.discordId !== null,
  };
}

/** Anzeigenamen begrenzen — sie landen ungefiltert in fremden Anzeigen. */
export function sanitizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Steuerzeichen entfernen: sie könnten Anzeigen zerlegen oder Namen tarnen.
  const name = raw.replace(/[\p{C}]/gu, '').trim();
  if (name.length < 2 || name.length > 24) return null;
  return name;
}
