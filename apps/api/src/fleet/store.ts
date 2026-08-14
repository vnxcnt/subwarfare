import type { FleetMineResponse, FleetSummary } from '@subwarfare/shared';
import {
  FLEET_RANK_LEADER,
  FLEET_RANK_MEMBER,
  progressionFromXp,
} from '@subwarfare/shared';
import { randomUUID } from 'node:crypto';
import type { AccountStore } from '../accounts/store.js';

/**
 * Flottillen-Datenhaltung. Wie bei Accounts/Inventar: ein async Interface,
 * dahinter eine Memory-Variante (lokale Entwicklung ohne DB) und eine
 * MySQL-Variante (VPS). RECHTE werden hier NICHT geprüft — das machen die
 * Routen mit den shared-Helfern; der Store liefert nur Primitive.
 */

export interface FleetMembership {
  fleetId: string;
  rank: number;
}

export interface FleetStore {
  /** Gründet eine Flottille; der Gründer wird Kommandant (Rang 1). */
  create(
    accountId: string,
    name: string,
    description: string | null,
  ): Promise<FleetMineResponse | 'name_taken' | 'already_member'>;
  /** Namenssuche, Teiltreffer, begrenzte Liste. Leere Suche = neueste zuerst. */
  search(query: string, limit: number): Promise<FleetSummary[]>;
  /** Eigene Flottille samt Mitgliederliste — null ohne Mitgliedschaft. */
  mine(accountId: string): Promise<FleetMineResponse | null>;
  /** Nur die Mitgliedschaft (fürs Rechte-Prüfen in den Routen). */
  membership(accountId: string): Promise<FleetMembership | null>;
  /** Beitritt als Besatzungsmitglied (Rang 5). */
  join(accountId: string, fleetId: string): Promise<'ok' | 'already_member' | 'not_found'>;
  /**
   * Austritt. Der Kommandant kann nur als LETZTES Mitglied gehen — dann löst
   * sich die Flottille auf; sonst muss er das Kommando erst übergeben.
   */
  leave(accountId: string): Promise<'ok' | 'not_member' | 'leader_must_transfer'>;
  /** Setzt den Rang eines Mitglieds — Rechte hat die Route bereits geprüft. */
  setRank(fleetId: string, accountId: string, rank: number): Promise<void>;
  /** Entfernt ein Mitglied — Rechte hat die Route bereits geprüft. */
  kick(fleetId: string, accountId: string): Promise<void>;
  /** Kassen-Gutschrift; der Coin-Abzug läuft vorher über den AccountStore. */
  addToTreasury(fleetId: string, amount: number): Promise<void>;
  close(): Promise<void>;
}

interface MemoryFleet {
  id: string;
  name: string;
  nameKey: string;
  description: string | null;
  treasury: number;
  createdAt: string;
}

interface MemoryMember {
  fleetId: string;
  rank: number;
  joinedAt: string;
}

/**
 * In-Memory-Variante — spiegelt das DB-Schema: `byName` entspricht dem
 * Unique-Index auf name_key, `members` (Schlüssel account_id) dem Primary Key
 * von fleet_members. Braucht den AccountStore für Namen und Level der
 * Mitgliederliste — in MariaDB erledigt das der JOIN.
 */
export class MemoryFleetStore implements FleetStore {
  private readonly fleets = new Map<string, MemoryFleet>();
  private readonly byName = new Map<string, string>();
  private readonly members = new Map<string, MemoryMember>();

  constructor(private readonly accounts: AccountStore) {}

  async create(
    accountId: string,
    name: string,
    description: string | null,
  ): Promise<FleetMineResponse | 'name_taken' | 'already_member'> {
    if (this.members.has(accountId)) return 'already_member';
    const nameKey = name.toLowerCase();
    if (this.byName.has(nameKey)) return 'name_taken';

    const fleet: MemoryFleet = {
      id: randomUUID(),
      name,
      nameKey,
      description,
      treasury: 0,
      createdAt: new Date().toISOString(),
    };
    this.fleets.set(fleet.id, fleet);
    this.byName.set(nameKey, fleet.id);
    this.members.set(accountId, {
      fleetId: fleet.id,
      rank: FLEET_RANK_LEADER,
      joinedAt: new Date().toISOString(),
    });
    return (await this.mine(accountId))!;
  }

  async search(query: string, limit: number): Promise<FleetSummary[]> {
    const needle = query.toLowerCase();
    const treffer: FleetSummary[] = [];
    const alle = [...this.fleets.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const fleet of alle) {
      if (needle && !fleet.nameKey.includes(needle)) continue;
      treffer.push({
        id: fleet.id,
        name: fleet.name,
        description: fleet.description,
        members: this.memberCount(fleet.id),
      });
      if (treffer.length >= limit) break;
    }
    return treffer;
  }

  async mine(accountId: string): Promise<FleetMineResponse | null> {
    const membership = this.members.get(accountId);
    if (!membership) return null;
    const fleet = this.fleets.get(membership.fleetId);
    if (!fleet) return null;

    const members = [];
    for (const [id, eintrag] of this.members) {
      if (eintrag.fleetId !== fleet.id) continue;
      const konto = await this.accounts.byId(id);
      members.push({
        accountId: id,
        displayName: konto?.displayName ?? 'Unbekannt',
        level: progressionFromXp(konto?.xp ?? 0).level,
        rank: eintrag.rank,
        joinedAt: eintrag.joinedAt,
      });
    }
    members.sort((a, b) => a.rank - b.rank || a.joinedAt.localeCompare(b.joinedAt));

    return {
      fleet: {
        id: fleet.id,
        name: fleet.name,
        description: fleet.description,
        treasury: fleet.treasury,
        createdAt: fleet.createdAt,
      },
      members,
    };
  }

  async membership(accountId: string): Promise<FleetMembership | null> {
    const eintrag = this.members.get(accountId);
    return eintrag ? { fleetId: eintrag.fleetId, rank: eintrag.rank } : null;
  }

  async join(accountId: string, fleetId: string): Promise<'ok' | 'already_member' | 'not_found'> {
    if (this.members.has(accountId)) return 'already_member';
    if (!this.fleets.has(fleetId)) return 'not_found';
    this.members.set(accountId, {
      fleetId,
      rank: FLEET_RANK_MEMBER,
      joinedAt: new Date().toISOString(),
    });
    return 'ok';
  }

  async leave(accountId: string): Promise<'ok' | 'not_member' | 'leader_must_transfer'> {
    const membership = this.members.get(accountId);
    if (!membership) return 'not_member';
    if (membership.rank === FLEET_RANK_LEADER && this.memberCount(membership.fleetId) > 1) {
      return 'leader_must_transfer';
    }
    this.members.delete(accountId);
    if (this.memberCount(membership.fleetId) === 0) {
      const fleet = this.fleets.get(membership.fleetId);
      if (fleet) {
        this.byName.delete(fleet.nameKey);
        this.fleets.delete(fleet.id);
      }
    }
    return 'ok';
  }

  async setRank(fleetId: string, accountId: string, rank: number): Promise<void> {
    const eintrag = this.members.get(accountId);
    if (eintrag && eintrag.fleetId === fleetId) eintrag.rank = rank;
  }

  async kick(fleetId: string, accountId: string): Promise<void> {
    const eintrag = this.members.get(accountId);
    if (eintrag && eintrag.fleetId === fleetId) this.members.delete(accountId);
  }

  async addToTreasury(fleetId: string, amount: number): Promise<void> {
    const fleet = this.fleets.get(fleetId);
    if (fleet) fleet.treasury += amount;
  }

  async close(): Promise<void> {
    // Nichts zu schließen.
  }

  private memberCount(fleetId: string): number {
    let count = 0;
    for (const eintrag of this.members.values()) if (eintrag.fleetId === fleetId) count += 1;
    return count;
  }
}
