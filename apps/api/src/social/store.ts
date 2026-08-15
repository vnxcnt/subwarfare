import type { ChatChannel } from '@subwarfare/shared';

/**
 * Freundschaften und gespeicherte Chat-Nachrichten.
 *
 * Wie bei Accounts/Inventar/Flottillen: ein async Interface, dahinter die
 * Memory-Variante (lokale Entwicklung) und MariaDB (VPS). REGELN (wer darf
 * wem schreiben, wer darf annehmen) prüfen Routen und Lobby-Gateway — der
 * Store liefert nur Primitive.
 */

export type FriendRequestResult =
  /** Anfrage gestellt, wartet auf die Gegenseite. */
  | 'requested'
  /** Die Gegenseite hatte selbst schon angefragt — beide sind jetzt Freunde. */
  | 'accepted'
  | 'already_friends'
  | 'already_requested';

/** Roh-Stand eines Kontos: nur Konto-IDs, hydriert wird in den Routen. */
export interface FriendshipSets {
  friends: string[];
  /** Anfragen AN dieses Konto. */
  incoming: string[];
  /** Offene Anfragen VON diesem Konto. */
  outgoing: string[];
}

export interface StoredMessageRow {
  id: number;
  senderId: string;
  text: string;
  at: string;
}

/**
 * Gesprächs-Schlüssel eines Privat-Kanals: beide Konto-IDs sortiert —
 * dieselbe Unterhaltung, egal wer schreibt.
 */
export function dmKey(a: string, b: string): string {
  return [a, b].sort().join(':');
}

export interface SocialStore {
  /**
   * Freundschaftsanfrage. Läuft bereits eine Anfrage der GEGENSEITE, wird
   * sie angenommen statt gespiegelt — zwei offene Anfragen desselben Paars
   * gibt es nie.
   */
  request(requesterId: string, addresseeId: string): Promise<FriendRequestResult>;
  /** Nimmt die Anfrage von `requesterId` an. 'not_found' = keine offene Anfrage. */
  accept(accountId: string, requesterId: string): Promise<'ok' | 'not_found'>;
  /** Lehnt die Anfrage von `requesterId` ab (löscht sie). */
  decline(accountId: string, requesterId: string): Promise<void>;
  /** Zieht die eigene Anfrage an `addresseeId` zurück. */
  cancel(accountId: string, addresseeId: string): Promise<void>;
  /** Beendet eine bestehende Freundschaft — egal, wer sie einst anfragte. */
  remove(accountId: string, otherId: string): Promise<void>;
  sets(accountId: string): Promise<FriendshipSets>;
  areFriends(a: string, b: string): Promise<boolean>;
  /** Speichert eine Zeile und liefert Kennung + Zeitstempel. */
  saveMessage(
    channel: ChatChannel,
    contextId: string,
    senderId: string,
    text: string,
  ): Promise<{ id: number; at: string }>;
  /** Die letzten `limit` Zeilen eines Kontexts, älteste zuerst. */
  messages(channel: ChatChannel, contextId: string, limit: number): Promise<StoredMessageRow[]>;
  /** Moderation: löscht ALLE gespeicherten Zeilen eines Absenders. */
  deleteBySender(accountId: string): Promise<void>;
  close(): Promise<void>;
}

interface MemoryFriendship {
  requesterId: string;
  addresseeId: string;
  accepted: boolean;
}

/** Speicher-Variante für die Entwicklung ohne Datenbank. */
export class MemorySocialStore implements SocialStore {
  /** Schlüssel = dmKey beider Konten — je Paar höchstens ein Eintrag. */
  private readonly friendships = new Map<string, MemoryFriendship>();
  /** Schlüssel = `${channel}/${contextId}`. */
  private readonly byContext = new Map<string, StoredMessageRow[]>();
  private nextMessageId = 1;

  /** Deckel je Gespräch — Speicherbetrieb ist Entwicklung, kein Archiv. */
  private static readonly MAX_PER_CONTEXT = 200;

  async request(requesterId: string, addresseeId: string): Promise<FriendRequestResult> {
    const key = dmKey(requesterId, addresseeId);
    const existing = this.friendships.get(key);
    if (existing) {
      if (existing.accepted) return 'already_friends';
      if (existing.requesterId === requesterId) return 'already_requested';
      existing.accepted = true;
      return 'accepted';
    }
    this.friendships.set(key, { requesterId, addresseeId, accepted: false });
    return 'requested';
  }

  async accept(accountId: string, requesterId: string): Promise<'ok' | 'not_found'> {
    const eintrag = this.friendships.get(dmKey(accountId, requesterId));
    if (!eintrag || eintrag.accepted || eintrag.requesterId !== requesterId) return 'not_found';
    eintrag.accepted = true;
    return 'ok';
  }

  async decline(accountId: string, requesterId: string): Promise<void> {
    const key = dmKey(accountId, requesterId);
    const eintrag = this.friendships.get(key);
    if (eintrag && !eintrag.accepted && eintrag.requesterId === requesterId) {
      this.friendships.delete(key);
    }
  }

  async cancel(accountId: string, addresseeId: string): Promise<void> {
    const key = dmKey(accountId, addresseeId);
    const eintrag = this.friendships.get(key);
    if (eintrag && !eintrag.accepted && eintrag.requesterId === accountId) {
      this.friendships.delete(key);
    }
  }

  async remove(accountId: string, otherId: string): Promise<void> {
    const key = dmKey(accountId, otherId);
    if (this.friendships.get(key)?.accepted) this.friendships.delete(key);
  }

  async sets(accountId: string): Promise<FriendshipSets> {
    const result: FriendshipSets = { friends: [], incoming: [], outgoing: [] };
    for (const eintrag of this.friendships.values()) {
      if (eintrag.requesterId !== accountId && eintrag.addresseeId !== accountId) continue;
      const other = eintrag.requesterId === accountId ? eintrag.addresseeId : eintrag.requesterId;
      if (eintrag.accepted) result.friends.push(other);
      else if (eintrag.requesterId === accountId) result.outgoing.push(other);
      else result.incoming.push(other);
    }
    return result;
  }

  async areFriends(a: string, b: string): Promise<boolean> {
    return this.friendships.get(dmKey(a, b))?.accepted ?? false;
  }

  async saveMessage(
    channel: ChatChannel,
    contextId: string,
    senderId: string,
    text: string,
  ): Promise<{ id: number; at: string }> {
    const key = `${channel}/${contextId}`;
    let liste = this.byContext.get(key);
    if (!liste) {
      liste = [];
      this.byContext.set(key, liste);
    }
    const row: StoredMessageRow = {
      id: this.nextMessageId++,
      senderId,
      text,
      at: new Date().toISOString(),
    };
    liste.push(row);
    if (liste.length > MemorySocialStore.MAX_PER_CONTEXT) {
      liste.splice(0, liste.length - MemorySocialStore.MAX_PER_CONTEXT);
    }
    return { id: row.id, at: row.at };
  }

  async messages(
    channel: ChatChannel,
    contextId: string,
    limit: number,
  ): Promise<StoredMessageRow[]> {
    const liste = this.byContext.get(`${channel}/${contextId}`) ?? [];
    return liste.slice(-Math.max(1, limit));
  }

  async deleteBySender(accountId: string): Promise<void> {
    for (const [key, liste] of this.byContext) {
      this.byContext.set(
        key,
        liste.filter((zeile) => zeile.senderId !== accountId),
      );
    }
  }

  async close(): Promise<void> {
    // Nichts zu schließen.
  }
}
