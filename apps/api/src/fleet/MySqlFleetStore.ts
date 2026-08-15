import type { FleetMineResponse, FleetSummary } from '@subwarfare/shared';
import {
  FLEET_RANK_LEADER,
  FLEET_RANK_MEMBER,
  progressionFromXp,
} from '@subwarfare/shared';
import { randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { getPool } from '../db/pool.js';
import type { FleetMembership, FleetStore } from './store.js';

interface FleetRow extends RowDataPacket {
  id: string;
  name: string;
  description: string | null;
  treasury: number;
  created_at: string;
}

interface MemberRow extends RowDataPacket {
  account_id: string;
  display_name: string;
  xp: number;
  rang: number;
  joined_at: string;
}

interface MembershipRow extends RowDataPacket {
  fleet_id: string;
  rang: number;
}

/**
 * MariaDB-Variante des FleetStore. Alle Abfragen über Prepared Statements;
 * die Eindeutigkeit (ein Konto = eine Flottille, ein Name = eine Flottille)
 * erzwingen die Schlüssel der Tabellen — der Code übersetzt ER_DUP_ENTRY nur
 * noch in die sprechenden Ergebnisse.
 */
export class MySqlFleetStore implements FleetStore {
  private readonly pool: Pool = getPool();

  async create(
    accountId: string,
    name: string,
    description: string | null,
  ): Promise<FleetMineResponse | 'name_taken' | 'already_member'> {
    const id = randomUUID();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        'INSERT INTO fleets (id, name, name_key, description) VALUES (?, ?, ?, ?)',
        [id, name, name.toLowerCase(), description],
      );
      await connection.execute(
        'INSERT INTO fleet_members (account_id, fleet_id, rang) VALUES (?, ?, ?)',
        [accountId, id, FLEET_RANK_LEADER],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
        // Zwei Unique-Schlüssel können hier zuschlagen: der Flottillen-Name
        // (fleets.name_key) oder die bestehende Mitgliedschaft (PK von
        // fleet_members). Die Meldung unterscheidet sie am Constraint-Namen.
        const message = (error as { message?: string }).message ?? '';
        return message.includes('fleet_members') ? 'already_member' : 'name_taken';
      }
      throw error;
    } finally {
      connection.release();
    }
    return (await this.mine(accountId))!;
  }

  async search(query: string, limit: number): Promise<FleetSummary[]> {
    // LIKE-Metazeichen entschärfen — eine Suche nach "%" soll das Zeichen
    // finden, nicht alles.
    const muster = `%${query.toLowerCase().replace(/[\\%_]/g, (zeichen) => `\\${zeichen}`)}%`;
    const [rows] = await this.pool.execute<(FleetRow & { members: number })[]>(
      `SELECT f.id, f.name, f.description, f.treasury, f.created_at,
              COUNT(m.account_id) AS members
         FROM fleets f
         LEFT JOIN fleet_members m ON m.fleet_id = f.id
        WHERE f.name_key LIKE ?
        GROUP BY f.id
        ORDER BY f.created_at DESC
        LIMIT ${Math.max(1, Math.min(50, Math.trunc(limit)))}`,
      [muster],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      members: Number(row.members),
    }));
  }

  async mine(accountId: string): Promise<FleetMineResponse | null> {
    const [fleets] = await this.pool.execute<FleetRow[]>(
      `SELECT f.id
         FROM fleets f
         JOIN fleet_members m ON m.fleet_id = f.id
        WHERE m.account_id = ?
        LIMIT 1`,
      [accountId],
    );
    const fleet = fleets[0];
    if (!fleet) return null;
    return this.profile(fleet.id);
  }

  async profile(fleetId: string): Promise<FleetMineResponse | null> {
    const [fleets] = await this.pool.execute<FleetRow[]>(
      `SELECT id, name, description, treasury, created_at FROM fleets WHERE id = ? LIMIT 1`,
      [fleetId],
    );
    const fleet = fleets[0];
    if (!fleet) return null;

    const [members] = await this.pool.execute<MemberRow[]>(
      `SELECT m.account_id, a.display_name, a.xp, m.rang, m.joined_at
         FROM fleet_members m
         JOIN accounts a ON a.id = m.account_id
        WHERE m.fleet_id = ?
        ORDER BY m.rang ASC, m.joined_at ASC`,
      [fleet.id],
    );

    return {
      fleet: {
        id: fleet.id,
        name: fleet.name,
        description: fleet.description,
        treasury: Number(fleet.treasury),
        createdAt: fleet.created_at,
      },
      members: members.map((row) => ({
        accountId: row.account_id,
        displayName: row.display_name,
        level: progressionFromXp(Number(row.xp)).level,
        rank: Number(row.rang),
        joinedAt: row.joined_at,
      })),
    };
  }

  async disband(fleetId: string): Promise<void> {
    // Der CASCADE-Fremdschlüssel räumt die Mitgliedszeilen mit.
    await this.pool.execute('DELETE FROM fleets WHERE id = ?', [fleetId]);
  }

  async membership(accountId: string): Promise<FleetMembership | null> {
    const [rows] = await this.pool.execute<MembershipRow[]>(
      'SELECT fleet_id, rang FROM fleet_members WHERE account_id = ? LIMIT 1',
      [accountId],
    );
    const row = rows[0];
    return row ? { fleetId: row.fleet_id, rank: Number(row.rang) } : null;
  }

  async join(accountId: string, fleetId: string): Promise<'ok' | 'already_member' | 'not_found'> {
    try {
      await this.pool.execute(
        'INSERT INTO fleet_members (account_id, fleet_id, rang) VALUES (?, ?, ?)',
        [accountId, fleetId, FLEET_RANK_MEMBER],
      );
      return 'ok';
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ER_DUP_ENTRY') return 'already_member';
      // Unbekannte fleet_id läuft in den Fremdschlüssel.
      if (code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_NO_REFERENCED_ROW') return 'not_found';
      throw error;
    }
  }

  async leave(accountId: string): Promise<'ok' | 'not_member' | 'leader_must_transfer'> {
    const membership = await this.membership(accountId);
    if (!membership) return 'not_member';

    if (membership.rank === FLEET_RANK_LEADER) {
      const [rows] = await this.pool.execute<(RowDataPacket & { anzahl: number })[]>(
        'SELECT COUNT(*) AS anzahl FROM fleet_members WHERE fleet_id = ?',
        [membership.fleetId],
      );
      if (Number(rows[0]?.anzahl ?? 0) > 1) return 'leader_must_transfer';
      // Letztes Mitglied: die Flottille löst sich auf — der CASCADE räumt
      // die Mitgliedszeile gleich mit.
      await this.pool.execute('DELETE FROM fleets WHERE id = ?', [membership.fleetId]);
      return 'ok';
    }

    await this.pool.execute('DELETE FROM fleet_members WHERE account_id = ?', [accountId]);
    return 'ok';
  }

  async setRank(fleetId: string, accountId: string, rank: number): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      'UPDATE fleet_members SET rang = ? WHERE account_id = ? AND fleet_id = ?',
      [rank, accountId, fleetId],
    );
  }

  async kick(fleetId: string, accountId: string): Promise<void> {
    await this.pool.execute('DELETE FROM fleet_members WHERE account_id = ? AND fleet_id = ?', [
      accountId,
      fleetId,
    ]);
  }

  async addToTreasury(fleetId: string, amount: number): Promise<void> {
    await this.pool.execute('UPDATE fleets SET treasury = treasury + ? WHERE id = ?', [
      amount,
      fleetId,
    ]);
  }

  async close(): Promise<void> {
    // Der Pool gehört dem AccountStore-Lebenszyklus (closePool dort).
  }
}
