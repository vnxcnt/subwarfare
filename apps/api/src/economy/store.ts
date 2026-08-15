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
  /**
   * Belegt einen Slot oder räumt ihn (`itemId: null`). `count` ist die
   * Wunschmenge für den Einsatz; `null` heißt „alles, was da ist".
   */
  setLoadout(
    accountId: string,
    model: string,
    slot: ItemCategory,
    itemId: ItemId | null,
    count?: number | null,
  ): Promise<void>;
  /**
   * Kauf: Stückpreis × Menge abziehen + Menge gutschreiben — beides EINE
   * Operation (siehe oben). 'poor' = Guthaben reicht für die GANZE Menge
   * nicht; Teilkäufe gibt es nicht.
   */
  purchase(
    accountId: string,
    itemId: ItemId,
    price: number,
    quantity: number,
  ): Promise<'ok' | 'poor'>;
  /**
   * Nimmt bis zu `limit` Stück eines Items aus dem Inventar (bei `null` den
   * ganzen Bestand) und liefert, wie viel tatsächlich ging. Damit geht die
   * Munition eines Einsatzes an Bord: das Ticket ist zugleich der
   * Lieferschein, und was der Einsatz nicht verbraucht, kommt über `credit`
   * zurück. Mehr als der Bestand geht nie — die Wunschmenge ist ein Deckel,
   * kein Anspruch.
   */
  take(accountId: string, itemId: ItemId, limit: number | null): Promise<number>;
  /** Schreibt Stücke gut — Rückgabe unverbrauchter Munition nach dem Einsatz. */
  credit(accountId: string, itemId: ItemId, amount: number): Promise<void>;
  /**
   * Setzt den Bestand ABSOLUT — Moderationswerkzeug. 0 räumt den Posten
   * (die Leseseite filtert Nullzeilen ohnehin aus).
   */
  setQuantity(accountId: string, itemId: ItemId, quantity: number): Promise<void>;
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
  /** accountId → `${model}/${slot}` → Item + Wunschmenge. */
  private readonly equipped = new Map<
    string,
    Map<string, { itemId: string; count: number | null }>
  >();

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
    return [...map.entries()].map(([key, eintrag]) => {
      const [model = '', slot = ''] = key.split('/');
      return { model, slot, itemId: eintrag.itemId, count: eintrag.count };
    });
  }

  async setLoadout(
    accountId: string,
    model: string,
    slot: ItemCategory,
    itemId: ItemId | null,
    count: number | null = null,
  ): Promise<void> {
    let map = this.equipped.get(accountId);
    if (!map) {
      map = new Map();
      this.equipped.set(accountId, map);
    }
    const key = `${model}/${slot}`;
    if (itemId === null) map.delete(key);
    else map.set(key, { itemId, count });
  }

  async purchase(
    accountId: string,
    itemId: ItemId,
    price: number,
    quantity: number,
  ): Promise<'ok' | 'poor'> {
    if (!(await this.accounts.spendCoins(accountId, price * quantity))) return 'poor';
    let map = this.owned.get(accountId);
    if (!map) {
      map = new Map();
      this.owned.set(accountId, map);
    }
    map.set(itemId, (map.get(itemId) ?? 0) + quantity);
    return 'ok';
  }

  async take(accountId: string, itemId: ItemId, limit: number | null): Promise<number> {
    const map = this.owned.get(accountId);
    const bestand = map?.get(itemId) ?? 0;
    const menge = limit === null ? bestand : Math.min(Math.max(limit, 0), bestand);
    if (menge > 0) map?.set(itemId, bestand - menge);
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

  async setQuantity(accountId: string, itemId: ItemId, quantity: number): Promise<void> {
    let map = this.owned.get(accountId);
    if (!map) {
      map = new Map();
      this.owned.set(accountId, map);
    }
    if (quantity <= 0) map.delete(itemId);
    else map.set(itemId, quantity);
  }

  async purge(accountId: string): Promise<void> {
    this.owned.delete(accountId);
    this.equipped.delete(accountId);
  }
}
