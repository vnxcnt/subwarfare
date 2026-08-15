import type { WerftPayload, WerftShip } from '@subwarfare/shared';
import { SHIP_SLOTS } from '@subwarfare/shared';
import { ref } from 'vue';
import { API_URL, account, token } from './auth';

/**
 * Werft-Zustand des Menüs: die Schiffs-Instanzen des Kontos. Wie überall ist
 * die api die Quelle der Wahrheit — jede Mutation übernimmt die
 * SERVER-Antwort (ships + coins), nie das lokal Erwartete.
 */

export const werftShips = ref<WerftShip[]>([]);
export const werftSlots = ref(SHIP_SLOTS);
export const werftLoaded = ref(false);
export const werftBusy = ref(false);
export const werftError = ref<string | null>(null);

/**
 * Uhr für den Reparatur-Countdown: `repairSecondsLeft` gilt zum Zeitpunkt des
 * Abrufs — die Anzeige zieht die seither vergangene Zeit ab. Der Ticker
 * startet mit dem ersten Abruf und läuft, solange das Modul lebt (eine
 * Sekunde Takt ist im Menü belanglos billig).
 */
export const werftNow = ref(Date.now());
const werftFetchedAt = ref(0);
let ticker: number | null = null;

function ensureTicker(): void {
  ticker ??= window.setInterval(() => {
    werftNow.value = Date.now();
  }, 1000);
}

async function api(path: string, body?: unknown): Promise<Response> {
  const headers = new Headers();
  if (token.value) headers.set('authorization', `Bearer ${token.value}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return fetch(`${API_URL}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function refreshWerft(): Promise<void> {
  try {
    const response = await api('/werft');
    if (!response.ok) return;
    const data = (await response.json()) as WerftPayload;
    werftShips.value = data.ships;
    werftSlots.value = data.slots;
    werftFetchedAt.value = Date.now();
    werftLoaded.value = true;
    ensureTicker();
  } catch {
    // Menü bleibt benutzbar — die Werft zeigt dann den letzten Stand.
  }
}

/**
 * Restsekunden einer laufenden Reparatur, live heruntergezählt. Läuft sie
 * ab, holt EIN frischer Abruf den fertigen Zustand (der Server schließt
 * lazy beim Lesen ab).
 */
let refreshAngefordert = false;

export function repairRemaining(ship: WerftShip): number | null {
  if (ship.repairSecondsLeft === null) return null;
  const vergangen = Math.floor((werftNow.value - werftFetchedAt.value) / 1000);
  const rest = ship.repairSecondsLeft - vergangen;
  if (rest <= 0) {
    if (!refreshAngefordert) {
      refreshAngefordert = true;
      void refreshWerft().finally(() => {
        refreshAngefordert = false;
      });
    }
    return 0;
  }
  return rest;
}

/** Gemeinsames Mutations-Muster: POST, Antwort (ships + coins) übernehmen. */
async function mutate(path: string, body: unknown): Promise<string | null> {
  if (werftBusy.value) return null;
  werftBusy.value = true;
  werftError.value = null;
  try {
    const response = await api(path, body);
    const data = (await response.json().catch(() => null)) as
      | { ships?: WerftShip[]; coins?: number; error?: string }
      | null;
    if (!response.ok) {
      const message = data?.error ?? `Aktion fehlgeschlagen (HTTP ${response.status}).`;
      werftError.value = message;
      return message;
    }
    if (data?.ships) {
      werftShips.value = data.ships;
      werftFetchedAt.value = Date.now();
      werftLoaded.value = true;
    }
    // Der Kontostand der Antwort ist frischer als das Profil im Speicher.
    if (data && typeof data.coins === 'number' && account.value) {
      account.value = { ...account.value, coins: data.coins };
    }
    return null;
  } catch {
    const message = 'Server ist nicht erreichbar.';
    werftError.value = message;
    return message;
  } finally {
    werftBusy.value = false;
  }
}

export function buyShip(model: string): Promise<string | null> {
  return mutate('/werft/buy', { model });
}

export function repairShip(shipId: string): Promise<string | null> {
  return mutate('/werft/repair', { shipId });
}

export function setShipPerks(shipId: string, perks: string[]): Promise<string | null> {
  return mutate('/werft/perks', { shipId, perks });
}
