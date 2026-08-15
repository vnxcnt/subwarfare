import type { PlayableModel } from '@subwarfare/shared';
import { randomUUID } from 'node:crypto';

/**
 * Schiffs-Instanzen eines Kontos (die Werft-Slots).
 *
 * Wie bei Accounts/Inventar: ein async Interface, dahinter Memory (lokale
 * Entwicklung) und MariaDB (VPS). REGELN (Slots, Preise, Reparatur-Formeln,
 * Perk-Prüfung) leben in der Service-Schicht und in shared — der Store
 * liefert nur Primitive.
 */

export interface AccountShip {
  id: string;
  accountId: string;
  model: PlayableModel;
  /** Aktuelle HP — das Maximum kennt nur der Schiffskatalog. */
  hp: number;
  /** Reparatur-Ende, null = keine Reparatur. */
  repairUntil: Date | null;
  /** Verbaute Perk-Item-Ids. */
  perks: string[];
  createdAt: string;
}

export interface WerftStore {
  /** Alle Schiffe des Kontos, älteste zuerst (stabile Slot-Reihenfolge). */
  list(accountId: string): Promise<AccountShip[]>;
  byId(shipId: string): Promise<AccountShip | null>;
  add(accountId: string, model: PlayableModel, hp: number): Promise<AccountShip>;
  setHp(shipId: string, hp: number): Promise<void>;
  setRepair(shipId: string, until: Date | null): Promise<void>;
  /** Reparatur abschließen: hp = maxHp UND repair_until leeren — EIN Schritt. */
  completeRepair(shipId: string, maxHp: number): Promise<void>;
  setPerks(shipId: string, perks: string[]): Promise<void>;
  /** Entfernt eine Instanz endgültig — Verschrotten, keine Erstattung. */
  remove(shipId: string): Promise<void>;
  count(accountId: string): Promise<number>;
  /** Memory-Aufräumen bei Kontolöschung; MariaDB erledigt das per CASCADE. */
  purge(accountId: string): Promise<void>;
  close(): Promise<void>;
}

/** Speicher-Variante für die Entwicklung ohne Datenbank. */
export class MemoryWerftStore implements WerftStore {
  private readonly ships = new Map<string, AccountShip>();

  async list(accountId: string): Promise<AccountShip[]> {
    return [...this.ships.values()]
      .filter((ship) => ship.accountId === accountId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async byId(shipId: string): Promise<AccountShip | null> {
    return this.ships.get(shipId) ?? null;
  }

  async add(accountId: string, model: PlayableModel, hp: number): Promise<AccountShip> {
    const ship: AccountShip = {
      id: randomUUID(),
      accountId,
      model,
      hp,
      repairUntil: null,
      perks: [],
      createdAt: new Date().toISOString(),
    };
    this.ships.set(ship.id, ship);
    return ship;
  }

  async setHp(shipId: string, hp: number): Promise<void> {
    const ship = this.ships.get(shipId);
    if (ship) ship.hp = hp;
  }

  async setRepair(shipId: string, until: Date | null): Promise<void> {
    const ship = this.ships.get(shipId);
    if (ship) ship.repairUntil = until;
  }

  async completeRepair(shipId: string, maxHp: number): Promise<void> {
    const ship = this.ships.get(shipId);
    if (ship) {
      ship.hp = maxHp;
      ship.repairUntil = null;
    }
  }

  async setPerks(shipId: string, perks: string[]): Promise<void> {
    const ship = this.ships.get(shipId);
    if (ship) ship.perks = [...perks];
  }

  async remove(shipId: string): Promise<void> {
    this.ships.delete(shipId);
  }

  async count(accountId: string): Promise<number> {
    return (await this.list(accountId)).length;
  }

  async purge(accountId: string): Promise<void> {
    for (const [id, ship] of this.ships) {
      if (ship.accountId === accountId) this.ships.delete(id);
    }
  }

  async close(): Promise<void> {
    // Nichts zu schließen.
  }
}
