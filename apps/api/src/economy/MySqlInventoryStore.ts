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
  wish_count: number | null;
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
      'SELECT model, slot, item_id, wish_count FROM ship_loadouts WHERE account_id = ?',
      [accountId],
    );
    return rows.map((row) => ({
      model: row.model,
      slot: row.slot,
      itemId: row.item_id,
      // mysql2 liefert INT NULL als null — alte Zeilen heißen damit „alles".
      count: row.wish_count === null ? null : Number(row.wish_count),
    }));
  }

  async setLoadout(
    accountId: string,
    model: string,
    slot: ItemCategory,
    itemId: ItemId | null,
    count: number | null = null,
  ): Promise<void> {
    if (itemId === null) {
      await this.pool.execute(
        'DELETE FROM ship_loadouts WHERE account_id = ? AND model = ? AND slot = ?',
        [accountId, model, slot],
      );
      return;
    }
    await this.pool.execute(
      `INSERT INTO ship_loadouts (account_id, model, slot, item_id, wish_count)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE item_id = VALUES(item_id), wish_count = VALUES(wish_count)`,
      [accountId, model, slot, itemId, count],
    );
  }

  async purchase(
    accountId: string,
    itemId: ItemId,
    price: number,
    quantity: number,
  ): Promise<'ok' | 'poor'> {
    // Abzug und Gutschrift in EINER Transaktion. Das bedingte UPDATE prüft das
    // Guthaben im selben Schritt, in dem es abzieht — zwei gleichzeitige Käufe
    // können dasselbe Guthaben nie doppelt ausgeben, und ein Absturz zwischen
    // den Schritten hinterlässt keinen Abzug ohne Item. Beim Mengenkauf gilt
    // ganz oder gar nicht: der Gesamtpreis muss gedeckt sein.
    const total = price * quantity;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [debit] = await connection.execute<ResultSetHeader>(
        'UPDATE accounts SET coins = coins - ? WHERE id = ? AND coins >= ?',
        [total, accountId, total],
      );
      if (debit.affectedRows !== 1) {
        await connection.rollback();
        return 'poor';
      }
      await connection.execute(
        `INSERT INTO account_items (account_id, item_id, quantity)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
        [accountId, itemId, quantity],
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

  async take(accountId: string, itemId: ItemId, limit: number | null): Promise<number> {
    // Lesen und Abziehen in EINER Transaktion, mit `FOR UPDATE` auf der Zeile:
    // ohne die Sperre könnte zwischen Lesen und Schreiben ein Kauf laufen, und
    // der würde beim Runterzählen mit verschwinden. Der Rückgabewert ist die
    // Stückzahl, die tatsächlich an Bord geht — der Lieferschein fürs Ticket.
    // `limit` deckelt die Entnahme (Wunschmenge); `null` nimmt alles.
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<ItemRow[]>(
        'SELECT quantity FROM account_items WHERE account_id = ? AND item_id = ? FOR UPDATE',
        [accountId, itemId],
      );
      const bestand = Number(rows[0]?.quantity ?? 0);
      const menge = limit === null ? bestand : Math.min(Math.max(limit, 0), bestand);
      if (menge <= 0) {
        await connection.rollback();
        return 0;
      }
      await connection.execute(
        'UPDATE account_items SET quantity = quantity - ? WHERE account_id = ? AND item_id = ?',
        [menge, accountId, itemId],
      );
      await connection.commit();
      return menge;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async credit(accountId: string, itemId: ItemId, amount: number): Promise<void> {
    if (amount <= 0) return;
    await this.pool.execute(
      `INSERT INTO account_items (account_id, item_id, quantity)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
      [accountId, itemId, amount],
    );
  }

  async setQuantity(accountId: string, itemId: ItemId, quantity: number): Promise<void> {
    if (quantity <= 0) {
      await this.pool.execute(
        'DELETE FROM account_items WHERE account_id = ? AND item_id = ?',
        [accountId, itemId],
      );
      return;
    }
    await this.pool.execute(
      `INSERT INTO account_items (account_id, item_id, quantity)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)`,
      [accountId, itemId, quantity],
    );
  }

  async purge(): Promise<void> {
    // Nichts zu tun: account_items und ship_loadouts hängen mit ON DELETE
    // CASCADE am Konto — die Löschung der accounts-Zeile räumt beide mit.
  }
}
