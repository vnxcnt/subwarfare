import type { FleetMineResponse, FleetSummary } from '@subwarfare/shared';
import { ref } from 'vue';
import { API_URL, account, token } from './auth';

/**
 * Flottillen-Zustand des Menüs. Gleiche Philosophie wie economy.ts: die api
 * ist die Quelle der Wahrheit — jede Änderung übernimmt die SERVER-Antwort
 * (`mine`) in den Zustand, nie das lokal Erwartete.
 */

export const myFleet = ref<FleetMineResponse | null>(null);
/** Erst nach dem ersten mine-Abruf aussagekräftig — sonst flackert „Gründen". */
export const fleetLoaded = ref(false);
export const fleetSearchResults = ref<FleetSummary[]>([]);
export const fleetBusy = ref(false);
export const fleetError = ref<string | null>(null);

async function api(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (token.value) headers.set('authorization', `Bearer ${token.value}`);
  if (init?.body) headers.set('content-type', 'application/json');
  return fetch(`${API_URL}/api${path}`, { ...init, headers });
}

export async function refreshMyFleet(): Promise<void> {
  try {
    const response = await api('/fleet/mine');
    if (!response.ok) return;
    const data = (await response.json()) as { mine: FleetMineResponse | null };
    myFleet.value = data.mine;
    fleetLoaded.value = true;
  } catch {
    // Menü bleibt benutzbar — der Bereich zeigt dann den letzten Stand.
  }
}

export async function searchFleets(query: string): Promise<void> {
  try {
    const response = await api(`/fleet/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) return;
    const data = (await response.json()) as { fleets: FleetSummary[] };
    fleetSearchResults.value = data.fleets;
  } catch {
    // Suche zeigt dann schlicht nichts Neues.
  }
}

/**
 * Gemeinsames Mutations-Muster: POST, bei Erfolg `mine` (und ggf. `coins`)
 * aus der Antwort übernehmen; liefert null bei Erfolg, sonst die Meldung.
 */
async function mutate(path: string, body?: unknown): Promise<string | null> {
  if (fleetBusy.value) return null;
  fleetBusy.value = true;
  fleetError.value = null;
  try {
    const response = await api(path, {
      method: 'POST',
      body: body === undefined ? '{}' : JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as
      | { mine?: FleetMineResponse | null; coins?: number; error?: string }
      | null;
    if (!response.ok) {
      const message = data?.error ?? `Aktion fehlgeschlagen (HTTP ${response.status}).`;
      fleetError.value = message;
      return message;
    }
    if (data && 'mine' in data) {
      myFleet.value = data.mine ?? null;
      fleetLoaded.value = true;
    }
    // Nach einer Einzahlung ist der Kontostand der Antwort frischer als das
    // Profil im Speicher — gleiches Muster wie beim Shop-Kauf.
    if (data && typeof data.coins === 'number' && account.value) {
      account.value = { ...account.value, coins: data.coins };
    }
    return null;
  } catch {
    const message = 'Server ist nicht erreichbar.';
    fleetError.value = message;
    return message;
  } finally {
    fleetBusy.value = false;
  }
}

export function createFleet(name: string, description: string): Promise<string | null> {
  return mutate('/fleet/create', { name, description });
}

export function joinFleet(fleetId: string): Promise<string | null> {
  return mutate('/fleet/join', { fleetId });
}

export function leaveFleet(): Promise<string | null> {
  return mutate('/fleet/leave');
}

export function setMemberRank(accountId: string, rank: number): Promise<string | null> {
  return mutate('/fleet/rank', { accountId, rank });
}

export function kickMember(accountId: string): Promise<string | null> {
  return mutate('/fleet/kick', { accountId });
}

export function donateToFleet(amount: number): Promise<string | null> {
  return mutate('/fleet/donate', { amount });
}
