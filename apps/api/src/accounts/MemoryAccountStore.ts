import { randomUUID } from 'node:crypto';
import type { PvpLeaderboardEntry, XpLeaderboardEntry } from '@subwarfare/shared';
import { progressionFromXp } from '@subwarfare/shared';
import type {
  Account,
  AccountStore,
  DiscordIdentity,
  GoogleIdentity,
  LinkResult,
} from './store.js';

/**
 * Konten im Arbeitsspeicher — für die Entwicklung ohne Datenbank.
 *
 * Beim Neustart ist alles weg. Das ist Absicht und der Grund, warum auf dem
 * VPS MariaDB läuft: Konten sollen persistent sein.
 */
export class MemoryAccountStore implements AccountStore {
  private readonly byIdMap = new Map<string, Account>();
  private readonly byGoogle = new Map<string, string>();
  private readonly byDiscord = new Map<string, string>();
  private readonly byDevName = new Map<string, string>();

  async upsertGoogle(identity: GoogleIdentity): Promise<Account> {
    const existingId = this.byGoogle.get(identity.googleSub);
    if (existingId) {
      const account = this.byIdMap.get(existingId)!;
      account.displayName = identity.displayName;
      account.avatarUrl = identity.avatarUrl;
      account.email = identity.email;
      return account;
    }

    const account = this.create({
      googleSub: identity.googleSub,
      discordId: null,
      email: identity.email,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      isDev: false,
    });
    this.byGoogle.set(identity.googleSub, account.id);
    return account;
  }

  async upsertDiscord(identity: DiscordIdentity): Promise<Account> {
    const existingId = this.byDiscord.get(identity.discordId);
    if (existingId) {
      const account = this.byIdMap.get(existingId)!;
      account.displayName = identity.displayName;
      account.avatarUrl = identity.avatarUrl;
      return account;
    }

    const account = this.create({
      googleSub: null,
      discordId: identity.discordId,
      email: null,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      isDev: false,
    });
    this.byDiscord.set(identity.discordId, account.id);
    return account;
  }

  async upsertDev(displayName: string): Promise<Account> {
    const key = displayName.toLowerCase();
    const existingId = this.byDevName.get(key);
    if (existingId) return this.byIdMap.get(existingId)!;

    const account = this.create({
      googleSub: null,
      discordId: null,
      email: null,
      displayName,
      avatarUrl: null,
      isDev: true,
    });
    // Der Entwickler-Zugang IST ein Entwicklerwerkzeug — im Speicherbetrieb
    // bekommt er die Entwicklerrolle, damit das Dev-Menue lokal testbar ist.
    account.role = 3;
    this.byDevName.set(key, account.id);
    return account;
  }

  async byId(id: string): Promise<Account | null> {
    return this.byIdMap.get(id) ?? null;
  }

  async touchLogin(id: string): Promise<void> {
    const account = this.byIdMap.get(id);
    if (account) account.lastLoginAt = new Date().toISOString();
  }

  async spendCoins(id: string, amount: number): Promise<boolean> {
    const account = this.byIdMap.get(id);
    if (!account || account.coins < amount) return false;
    account.coins -= amount;
    return true;
  }

  async addCoins(id: string, amount: number): Promise<void> {
    const account = this.byIdMap.get(id);
    if (account) account.coins += amount;
  }

  async addXp(id: string, amount: number): Promise<void> {
    const account = this.byIdMap.get(id);
    if (account) account.xp += amount;
  }

  async recordPvpKill(id: string): Promise<void> {
    const account = this.byIdMap.get(id);
    if (account) account.kills += 1;
  }

  async recordPvpDeath(id: string): Promise<void> {
    const account = this.byIdMap.get(id);
    if (account) account.deaths += 1;
  }

  async topPvp(limit: number): Promise<PvpLeaderboardEntry[]> {
    // Identische Filter- und Sortierlogik wie im MySqlAccountStore.
    return [...this.byIdMap.values()]
      .filter((account) => account.kills > 0 || account.deaths > 0)
      .sort(
        (a, b) =>
          b.kills - a.kills ||
          a.deaths - b.deaths ||
          a.displayName.localeCompare(b.displayName),
      )
      .slice(0, Math.max(1, Math.trunc(limit)))
      .map((account) => ({
        accountId: account.id,
        displayName: account.displayName,
        level: progressionFromXp(account.xp).level,
        kills: account.kills,
        deaths: account.deaths,
      }));
  }

  async topXp(limit: number): Promise<XpLeaderboardEntry[]> {
    return [...this.byIdMap.values()]
      .filter((account) => account.xp > 0)
      .sort((a, b) => b.xp - a.xp || a.displayName.localeCompare(b.displayName))
      .slice(0, Math.max(1, Math.trunc(limit)))
      .map((account) => ({
        accountId: account.id,
        displayName: account.displayName,
        level: progressionFromXp(account.xp).level,
        xp: account.xp,
      }));
  }

  async linkGoogle(id: string, identity: GoogleIdentity): Promise<LinkResult> {
    const account = this.byIdMap.get(id);
    if (!account) return 'conflict';
    if (account.googleSub === identity.googleSub) return 'ok';
    if (account.googleSub !== null) return 'conflict';
    if (this.byGoogle.has(identity.googleSub)) return 'taken';
    account.googleSub = identity.googleSub;
    account.email ??= identity.email;
    this.byGoogle.set(identity.googleSub, id);
    return 'ok';
  }

  async linkDiscord(id: string, identity: DiscordIdentity): Promise<LinkResult> {
    const account = this.byIdMap.get(id);
    if (!account) return 'conflict';
    if (account.discordId === identity.discordId) return 'ok';
    if (account.discordId !== null) return 'conflict';
    if (this.byDiscord.has(identity.discordId)) return 'taken';
    account.discordId = identity.discordId;
    this.byDiscord.set(identity.discordId, id);
    return 'ok';
  }

  async deleteAccount(id: string): Promise<void> {
    const account = this.byIdMap.get(id);
    if (!account) return;
    this.byIdMap.delete(id);
    // Auch die Rückwärts-Verweise räumen — sonst zeigte der nächste Login mit
    // derselben Identität auf ein Konto, das nicht mehr existiert.
    if (account.googleSub) this.byGoogle.delete(account.googleSub);
    if (account.discordId) this.byDiscord.delete(account.discordId);
    for (const [key, accountId] of this.byDevName) {
      if (accountId === id) this.byDevName.delete(key);
    }
  }

  async close(): Promise<void> {
    // Nichts zu schließen.
  }

  private create(
    fields: Omit<
      Account,
      'id' | 'createdAt' | 'lastLoginAt' | 'coins' | 'xp' | 'role' | 'kills' | 'deaths'
    >,
  ): Account {
    const now = new Date().toISOString();
    const account: Account = {
      ...fields,
      id: randomUUID(),
      // Startwerte wie das Datenbank-Schema: ohne Guthaben, ohne Erfahrung.
      coins: 0,
      xp: 0,
      role: 0,
      kills: 0,
      deaths: 0,
      createdAt: now,
      lastLoginAt: now,
    };
    this.byIdMap.set(account.id, account);
    return account;
  }
}
