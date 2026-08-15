import type { PlayableModel } from '@subwarfare/shared';
import { isPlayableModel } from '@subwarfare/shared';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { getPool } from '../db/pool.js';
import type { AccountShip, WerftStore } from './store.js';

interface ShipRow extends RowDataPacket {
  id: string;
  account_id: string;
  model: string;
  hp: number;
  repair_until: string | Date | null;
  perks: unknown;
  created_at: string | Date;
}

function toShip(row: ShipRow): AccountShip {
  // mysql2 liefert JSON-Spalten bereits geparst — defensiv filtern, damit
  // eine von Hand editierte Zeile nie Nicht-Strings in den Code spült.
  const perks = Array.isArray(row.perks)
    ? row.perks.filter((eintrag): eintrag is string => typeof eintrag === 'string')
    : [];
  return {
    id: row.id,
    accountId: row.account_id,
    // Unbekannte Modelle (entferntes Schiff nach Rebalance) fallen auf die
    // Fregatte zurück, statt den ganzen Abruf zu sprengen.
    model: isPlayableModel(row.model) ? row.model : 'fregatte01',
    hp: Number(row.hp),
    repairUntil: row.repair_until === null ? null : new Date(row.repair_until),
    perks,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const SELECT = `SELECT id, account_id, model, hp, repair_until, perks, created_at
                  FROM account_ships`;

/** Schiffs-Instanzen in MariaDB — alle Abfragen über execute (prepared). */
export class MySqlWerftStore implements WerftStore {
  private readonly pool: Pool = getPool();

  async list(accountId: string): Promise<AccountShip[]> {
    const [rows] = await this.pool.execute<ShipRow[]>(
      `${SELECT} WHERE account_id = ? ORDER BY created_at ASC, id ASC`,
      [accountId],
    );
    return rows.map(toShip);
  }

  async byId(shipId: string): Promise<AccountShip | null> {
    const [rows] = await this.pool.execute<ShipRow[]>(`${SELECT} WHERE id = ? LIMIT 1`, [shipId]);
    const row = rows[0];
    return row ? toShip(row) : null;
  }

  async add(accountId: string, model: PlayableModel, hp: number): Promise<AccountShip> {
    const id = randomUUID();
    await this.pool.execute(
      `INSERT INTO account_ships (id, account_id, model, hp, repair_until, perks)
       VALUES (?, ?, ?, ?, NULL, ?)`,
      [id, accountId, model, hp, JSON.stringify([])],
    );
    const ship = await this.byId(id);
    if (!ship) throw new Error('Schiff konnte nach dem Anlegen nicht gelesen werden.');
    return ship;
  }

  async setHp(shipId: string, hp: number): Promise<void> {
    await this.pool.execute('UPDATE account_ships SET hp = ? WHERE id = ?', [hp, shipId]);
  }

  async setRepair(shipId: string, until: Date | null): Promise<void> {
    await this.pool.execute('UPDATE account_ships SET repair_until = ? WHERE id = ?', [
      until,
      shipId,
    ]);
  }

  async completeRepair(shipId: string, maxHp: number): Promise<void> {
    await this.pool.execute(
      'UPDATE account_ships SET hp = ?, repair_until = NULL WHERE id = ?',
      [maxHp, shipId],
    );
  }

  async setPerks(shipId: string, perks: string[]): Promise<void> {
    await this.pool.execute('UPDATE account_ships SET perks = ? WHERE id = ?', [
      JSON.stringify(perks),
      shipId,
    ]);
  }

  async remove(shipId: string): Promise<void> {
    await this.pool.execute('DELETE FROM account_ships WHERE id = ?', [shipId]);
  }

  async count(accountId: string): Promise<number> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS anzahl FROM account_ships WHERE account_id = ?',
      [accountId],
    );
    return Number(rows[0]?.['anzahl'] ?? 0);
  }

  async purge(): Promise<void> {
    // account_ships hängt mit ON DELETE CASCADE am Konto.
  }

  async close(): Promise<void> {
    // Der geteilte Pool wird zentral geschlossen (AccountStore.close).
  }
}
