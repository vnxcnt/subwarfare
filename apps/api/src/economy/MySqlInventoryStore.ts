import type { InventoryItem, ItemCategory, ItemId, LoadoutEntry } from '@subwarfare/shared';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { getPool } from '../db/pool.js';
import type { InventoryStore } from './store.js';

interface ItemRow extends RowDataPacket {
  item_id: string;
  quantity: number;
}

interface LoadoutRow extends RowDataPacket {
  model: string;
  slot: string;
  item_id: string;
}

/**
 * Inventar in MariaDB. Wie beim Konten-Store laufen alle Abfragen über
 * `execute` (vorbereitete Anweisungen) — SQL-Injektion ist strukturell
 * ausgeschlossen.
 */
export class MySqlInventoryStore implements InventoryStore {
  private readonly pool: Pool = getPool();

  async items(accountId: string): Promise<InventoryItem[]> {
    const [rows] = await this.pool.execute<ItemRow[]>(
      'SELECT item_id, quantity FROM account_items WHERE account_id = ? AND quantity > 0',
      [accountId],
    );
    return rows.map((row) => ({ itemId: row.item_id, quantity: row.quantity }));
  }

  async loadouts(accountId: string): Promise<LoadoutEntry[]> {
    const [rows] = await this.pool.execute<LoadoutRow[]>(
      'SELECT model, slot, item_id FROM ship_loadouts WHERE account_id = ?',
      [accountId],
    );
    return rows.map((row) => ({ model: row.model, slot: row.slot, itemId: row.item_id }));
  }

  async setLoadout(
    accountId: string,
    model: string,
    slot: ItemCategory,
    itemId: ItemId | null,
  ): Promise<void> {
    if (itemId === null) {
      await this.pool.execute(
        'DELETE FROM ship_loadouts WHERE account_id = ? AND model = ? AND slot = ?',
        [accountId, model, slot],
      );
      return;
    }
    await this.pool.execute(
      `INSERT INTO ship_loadouts (account_id, model, slot, item_id)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE item_id = VALUES(item_id)`,
      [accountId, model, slot, itemId],
    );
  }

  async purchase(accountId: string, itemId: ItemId, price: number): Promise<'ok' | 'poor'> {
    // Abzug und Gutschrift in EINER Transaktion. Das bedingte UPDATE prüft das
    // Guthaben im selben Schritt, in dem es abzieht — zwei gleichzeitige Käufe
    // können dasselbe Guthaben nie doppelt ausgeben, und ein Absturz zwischen
    // den Schritten hinterlässt keinen Abzug ohne Item.
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [debit] = await connection.execute<ResultSetHeader>(
        'UPDATE accounts SET coins = coins - ? WHERE id = ? AND coins >= ?',
        [price, accountId, price],
      );
      if (debit.affectedRows !== 1) {
        await connection.rollback();
        return 'poor';
      }
      await connection.execute(
        `INSERT INTO account_items (account_id, item_id, quantity)
         VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE quantity = quantity + 1`,
        [accountId, itemId],
      );
      await connection.commit();
      return 'ok';
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async purge(): Promise<void> {
    // Nichts zu tun: account_items und ship_loadouts hängen mit ON DELETE
    // CASCADE am Konto — die Löschung der accounts-Zeile räumt beide mit.
  }
}
