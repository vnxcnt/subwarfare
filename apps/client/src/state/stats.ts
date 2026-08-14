import type { StatsLeaderboardResponse } from '@subwarfare/shared';
import { ref } from 'vue';
import { API_URL, token } from './auth';

/**
 * Bestenlisten-Zustand des Menüs. Rein lesend — Mutationen gibt es nicht,
 * die Zahlen schreibt ausschließlich der Spielserver über den internen Kanal.
 * Gleiche Philosophie wie fleet.ts: bei Fehlern bleibt der letzte Stand
 * stehen, das Menü bleibt benutzbar.
 */

export const leaderboard = ref<StatsLeaderboardResponse | null>(null);
/** Erst nach dem ersten Abruf aussagekräftig — sonst flackert „keine Daten". */
export const leaderboardLoaded = ref(false);

export async function refreshLeaderboard(): Promise<void> {
  try {
    const headers = new Headers();
    if (token.value) headers.set('authorization', `Bearer ${token.value}`);
    const response = await fetch(`${API_URL}/api/stats/leaderboard`, { headers });
    if (!response.ok) return;
    leaderboard.value = (await response.json()) as StatsLeaderboardResponse;
    leaderboardLoaded.value = true;
  } catch {
    // Menü bleibt benutzbar — der Bereich zeigt dann den letzten Stand.
  }
}
