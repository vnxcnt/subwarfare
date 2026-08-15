import type { ChatChannel } from '@subwarfare/shared';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { getPool } from '../db/pool.js';
import type {
  FriendRequestResult,
  FriendshipSets,
  SocialStore,
  StoredMessageRow,
} from './store.js';

interface FriendshipRow extends RowDataPacket {
  requester_id: string;
  addressee_id: string;
  status: number;
}

interface MessageRow extends RowDataPacket {
  id: number;
  sender_id: string;
  text: string;
  created_at: string | Date;
}

/**
 * Freundschaften und Chat-Verlauf in MariaDB. Eine Zeile je Paar in
 * `friendships` (gerichtet: wer angefragt hat), status 0 = offen,
 * 1 = angenommen. Alle Abfragen über `execute` — SQL-Injektion strukturell
 * ausgeschlossen.
 */
export class MySqlSocialStore implements SocialStore {
  private readonly pool: Pool = getPool();

  async request(requesterId: string, addresseeId: string): Promise<FriendRequestResult> {
    const [rows] = await this.pool.execute<FriendshipRow[]>(
      `SELECT requester_id, addressee_id, status FROM friendships
        WHERE (requester_id = ? AND addressee_id = ?)
           OR (requester_id = ? AND addressee_id = ?)
        LIMIT 1`,
      [requesterId, addresseeId, addresseeId, requesterId],
    );
    const existing = rows[0];
    if (existing) {
      if (existing.status === 1) return 'already_friends';
      if (existing.requester_id === requesterId) return 'already_requested';
      // Die Gegenseite hatte selbst schon angefragt — das IST die Annahme.
      await this.pool.execute(
        'UPDATE friendships SET status = 1 WHERE requester_id = ? AND addressee_id = ?',
        [addresseeId, requesterId],
      );
      return 'accepted';
    }
    try {
      await this.pool.execute(
        'INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, 0)',
        [requesterId, addresseeId],
      );
    } catch (error) {
      // Wettlauf zweier gleichzeitiger Anfragen — der Primary Key entscheidet.
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return 'already_requested';
      throw error;
    }
    return 'requested';
  }

  async accept(accountId: string, requesterId: string): Promise<'ok' | 'not_found'> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE friendships SET status = 1
        WHERE requester_id = ? AND addressee_id = ? AND status = 0`,
      [requesterId, accountId],
    );
    return result.affectedRows === 1 ? 'ok' : 'not_found';
  }

  async decline(accountId: string, requesterId: string): Promise<void> {
    await this.pool.execute(
      'DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 0',
      [requesterId, accountId],
    );
  }

  async cancel(accountId: string, addresseeId: string): Promise<void> {
    await this.pool.execute(
      'DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 0',
      [accountId, addresseeId],
    );
  }

  async remove(accountId: string, otherId: string): Promise<void> {
    await this.pool.execute(
      `DELETE FROM friendships
        WHERE status = 1
          AND ((requester_id = ? AND addressee_id = ?)
            OR (requester_id = ? AND addressee_id = ?))`,
      [accountId, otherId, otherId, accountId],
    );
  }

  async sets(accountId: string): Promise<FriendshipSets> {
    const [rows] = await this.pool.execute<FriendshipRow[]>(
      `SELECT requester_id, addressee_id, status FROM friendships
        WHERE requester_id = ? OR addressee_id = ?`,
      [accountId, accountId],
    );
    const result: FriendshipSets = { friends: [], incoming: [], outgoing: [] };
    for (const row of rows) {
      const other = row.requester_id === accountId ? row.addressee_id : row.requester_id;
      if (row.status === 1) result.friends.push(other);
      else if (row.requester_id === accountId) result.outgoing.push(other);
      else result.incoming.push(other);
    }
    return result;
  }

  async areFriends(a: string, b: string): Promise<boolean> {
    const [rows] = await this.pool.execute<FriendshipRow[]>(
      `SELECT status FROM friendships
        WHERE status = 1
          AND ((requester_id = ? AND addressee_id = ?)
            OR (requester_id = ? AND addressee_id = ?))
        LIMIT 1`,
      [a, b, b, a],
    );
    return rows.length > 0;
  }

  async saveMessage(
    channel: ChatChannel,
    contextId: string,
    senderId: string,
    text: string,
  ): Promise<{ id: number; at: string }> {
    // Zeitstempel aus JS statt NOW(): so ist der Rückgabewert exakt das, was
    // gespeichert wurde, ohne die Zeile erneut zu lesen.
    const at = new Date();
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO chat_messages (channel, context_id, sender_id, text, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [channel, contextId, senderId, text, at],
    );
    return { id: result.insertId, at: at.toISOString() };
  }

  async messages(
    channel: ChatChannel,
    contextId: string,
    limit: number,
  ): Promise<StoredMessageRow[]> {
    // Die letzten N über absteigende Sortierung greifen, dann umdrehen —
    // LIMIT inline geklemmt (Prepared LIMIT ? zickt, Muster MySqlFleetStore).
    const n = Math.max(1, Math.min(200, Math.trunc(limit)));
    const [rows] = await this.pool.execute<MessageRow[]>(
      `SELECT id, sender_id, text, created_at FROM chat_messages
        WHERE channel = ? AND context_id = ?
        ORDER BY id DESC
        LIMIT ${n}`,
      [channel, contextId],
    );
    return rows.reverse().map((row) => ({
      id: Number(row.id),
      senderId: row.sender_id,
      text: row.text,
      at: new Date(row.created_at).toISOString(),
    }));
  }

  async deleteBySender(accountId: string): Promise<void> {
    await this.pool.execute('DELETE FROM chat_messages WHERE sender_id = ?', [accountId]);
  }

  async close(): Promise<void> {
    // Der geteilte Pool wird zentral geschlossen (AccountStore.close).
  }
}
