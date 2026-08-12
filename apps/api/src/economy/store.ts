import type { InventoryItem, ItemCategory, ItemId, LoadoutEntry } from '@subwarfare/shared';
import type { AccountStore } from '../accounts/store.js';

/**
 * Item-Besitz und Schiffs-Ausrüstung je Konto.
 *
 * Durchgehend `async` aus demselben Grund wie beim `AccountStore`: die
 * Schnittstelle soll beim Wechsel zwischen Speicher- und MariaDB-Betrieb
 * identisch bleiben.
 *
 * Der Kauf ist bewusst EINE Operation (`purchase`) statt „Coins abziehen,
 * dann Item gutschreiben" im Aufrufer: in MariaDB laufen beide Schritte in
 * einer Transaktion — ein Absturz dazwischen kann so nie Coins verbrennen,
 * ohne das Item zu liefern.
 */
export interface InventoryStore {
  items(accountId: string): Promise<InventoryItem[]>;
  loadouts(accountId: string): Promise<LoadoutEntry[]>;
  /** Belegt einen Slot oder räumt ihn (`itemId: null`). */
  setLoadout(
    accountId: string,
    model: string,
    slot: ItemCategory,
    itemId: ItemId | null,
  ): Promise<void>;
  /** Kauf: Coins abziehen + 1 Stück gutschreiben. 'poor' = Guthaben reicht nicht. */
  purchase(accountId: string, itemId: ItemId, price: number): Promise<'ok' | 'poor'>;
  /**
   * Nimmt den GANZEN Bestand eines Items aus dem Inventar und liefert, wie viel
   * es war. Damit geht die Munition eines Einsatzes an Bord: das Ticket ist
   * zugleich der Lieferschein, und was der Einsatz nicht verbraucht, kommt über
   * `credit` zurück.
   *
   * Bewusst „alles oder nichts" statt einer Wunschmenge: die Werft kennt keine
   * Stückzahl, sie kennt nur den Slot. Wer weniger mitnehmen will, kauft
   * weniger.
   */
  takeAll(accountId: string, itemId: ItemId): Promise<number>;
  /** Schreibt Stücke gut — Rückgabe unverbrauchter Munition nach dem Einsatz. */
  credit(accountId: string, itemId: ItemId, amount: number): Promise<void>;
  /**
   * Räumt Besitz und Zuordnungen eines Kontos — Teil der Konto-Löschung.
   * In MariaDB erledigt das der CASCADE-Fremdschlüssel, dort ist es ein No-op;
   * der Speicher-Betrieb hat keine Fremdschlüssel und muss selbst aufräumen.
   */
  purge(accountId: string): Promise<void>;
}

/** Speicher-Variante für die Entwicklung ohne Datenbank. */
export class MemoryInventoryStore implements InventoryStore {
  /** accountId → itemId → Stückzahl. */
  private readonly owned = new Map<string, Map<string, number>>();
  /** accountId → `${model}/${slot}` → itemId. */
  private readonly equipped = new Map<string, Map<string, string>>();

  /**
   * Coins liegen im Konto, nicht hier — der Kauf bucht über denselben
   * `spendCoins`-Weg ab wie die Einsatzkosten der Lobby.
   */
  constructor(private readonly accounts: AccountStore) {}

  async items(accountId: string): Promise<InventoryItem[]> {
    const map = this.owned.get(accountId);
    if (!map) return [];
    // Nullposten fallen raus — die MariaDB-Variante filtert genauso
    // (`quantity > 0`). Seit die Munition an Bord geht, entstehen sie
    // regelmäßig, und ohne den Filter böte die Werft „Torpedo MK I ×0" an.
    return [...map.entries()]
      .filter(([, quantity]) => quantity > 0)
      .map(([itemId, quantity]) => ({ itemId, quantity }));
  }

  async loadouts(accountId: string): Promise<LoadoutEntry[]> {
    const map = this.equipped.get(accountId);
    if (!map) return [];
    return [...map.entries()].map(([key, itemId]) => {
      const [model = '', slot = ''] = key.split('/');
      return { model, slot, itemId };
    });
  }

  async setLoadout(
    accountId: string,
    model: string,
    slot: ItemCategory,
    itemId: ItemId | null,
  ): Promise<void> {
    let map = this.equipped.get(accountId);
    if (!map) {
      map = new Map();
      this.equipped.set(accountId, map);
    }
    const key = `${model}/${slot}`;
    if (itemId === null) map.delete(key);
    else map.set(key, itemId);
  }

  async purchase(accountId: string, itemId: ItemId, price: number): Promise<'ok' | 'poor'> {
    if (!(await this.accounts.spendCoins(accountId, price))) return 'poor';
    let map = this.owned.get(accountId);
    if (!map) {
      map = new Map();
      this.owned.set(accountId, map);
    }
    map.set(itemId, (map.get(itemId) ?? 0) + 1);
    return 'ok';
  }

  async takeAll(accountId: string, itemId: ItemId): Promise<number> {
    const map = this.owned.get(accountId);
    const menge = map?.get(itemId) ?? 0;
    if (menge > 0) map?.set(itemId, 0);
    return menge;
  }

  async credit(accountId: string, itemId: ItemId, amount: number): Promise<void> {
    if (amount <= 0) return;
    let map = this.owned.get(accountId);
    if (!map) {
      map = new Map();
      this.owned.set(accountId, map);
    }
    map.set(itemId, (map.get(itemId) ?? 0) + amount);
  }

  async purge(accountId: string): Promise<void> {
    this.owned.delete(accountId);
    this.equipped.delete(accountId);
  }
}
