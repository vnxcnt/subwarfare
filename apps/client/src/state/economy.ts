import type {
  InventoryItem,
  InventoryPayload,
  ItemCategory,
  ItemId,
  LoadoutEntry,
  ShopBuyResponse,
} from '@subwarfare/shared';
import { ref } from 'vue';
import { API_URL, account, token } from './auth';

/**
 * Inventar, Shop und Ausrüstung fürs Hauptmenü.
 *
 * Die api ist die Quelle der Wahrheit: jede Änderung (Kauf, Slot-Belegung)
 * übernimmt die SERVER-Antwort in den Zustand, nie das lokal Erwartete. Der
 * Katalog (Namen, Preise, Kategorien) kommt aus `@subwarfare/shared` und wird
 * hier gar nicht erst gespeichert.
 */

export const inventoryItems = ref<InventoryItem[]>([]);
export const loadouts = ref<LoadoutEntry[]>([]);
/** Läuft gerade eine Anfrage? Blendet Doppelklicks und zeigt Wartezustände. */
export const economyBusy = ref(false);
export const economyError = ref<string | null>(null);

async function api(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (token.value) headers.set('authorization', `Bearer ${token.value}`);
  if (init?.body) headers.set('content-type', 'application/json');
  return fetch(`${API_URL}/api${path}`, { ...init, headers });
}

/** Stückzahl eines Items im Besitz. */
export function ownedQuantity(itemId: ItemId): number {
  return inventoryItems.value.find((entry) => entry.itemId === itemId)?.quantity ?? 0;
}

/** Belegung eines Slots — null, wenn leer. */
export function equippedItem(model: string, slot: ItemCategory): string | null {
  return (
    loadouts.value.find((entry) => entry.model === model && entry.slot === slot)?.itemId ?? null
  );
}

export async function refreshInventory(): Promise<void> {
  try {
    const response = await api('/inventory');
    if (!response.ok) return;
    const data = (await response.json()) as InventoryPayload;
    inventoryItems.value = data.items;
    loadouts.value = data.loadouts;
  } catch {
    // Menü bleibt benutzbar — Inventar zeigt dann den letzten Stand.
  }
}

/** Kauft ein Item. Liefert null bei Erfolg, sonst die Fehlermeldung. */
export async function buyItem(itemId: ItemId): Promise<string | null> {
  if (economyBusy.value) return null;
  economyBusy.value = true;
  economyError.value = null;
  try {
    const response = await api('/shop/buy', { method: 'POST', body: JSON.stringify({ itemId }) });
    const body = (await response.json().catch(() => null)) as
      | (ShopBuyResponse & { error?: string })
      | null;
    if (!response.ok) {
      const message = body?.error ?? `Kauf fehlgeschlagen (HTTP ${response.status}).`;
      economyError.value = message;
      return message;
    }
    if (body) {
      inventoryItems.value = body.items;
      // Der Kontostand der Antwort ist frischer als das Profil im Speicher.
      if (account.value) account.value = { ...account.value, coins: body.coins };
    }
    return null;
  } catch {
    const message = 'Server ist nicht erreichbar.';
    economyError.value = message;
    return message;
  } finally {
    economyBusy.value = false;
  }
}

/** Belegt oder räumt einen Ausrüstungs-Slot. Liefert null bei Erfolg. */
export async function equip(
  model: string,
  slot: ItemCategory,
  itemId: ItemId | null,
): Promise<string | null> {
  if (economyBusy.value) return null;
  economyBusy.value = true;
  economyError.value = null;
  try {
    const response = await api('/loadout', {
      method: 'POST',
      body: JSON.stringify({ model, slot, itemId }),
    });
    const body = (await response.json().catch(() => null)) as
      | { loadouts?: LoadoutEntry[]; error?: string }
      | null;
    if (!response.ok) {
      const message = body?.error ?? `Ausrüsten fehlgeschlagen (HTTP ${response.status}).`;
      economyError.value = message;
      return message;
    }
    if (body?.loadouts) loadouts.value = body.loadouts;
    return null;
  } catch {
    const message = 'Server ist nicht erreichbar.';
    economyError.value = message;
    return message;
  } finally {
    economyBusy.value = false;
  }
}
