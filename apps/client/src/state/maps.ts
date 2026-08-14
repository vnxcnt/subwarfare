import { ref } from 'vue';
import { API_URL } from './auth';

/**
 * Auslastung je Karte (Spieler an Bord) — vom Backend. Null-Äquivalent ist das
 * leere Objekt, solange noch keine Antwort da ist. Der 10-s-Auffrisch-Timer
 * gehört der Menü-Shell (Lifecycle), nicht diesem Modul — hier liegt nur der
 * Zustand, damit das Auslaufen-Panel ihn lesen kann, ohne den Timer zu besitzen.
 */
export const mapStatus = ref<Record<string, { players: number; capacity: number }>>({});

export async function refreshMapStatus(): Promise<void> {
  try {
    const response = await fetch(`${API_URL}/api/maps/status`);
    if (!response.ok) return;
    const data = (await response.json()) as {
      maps?: Array<{ mapId: string; players: number; capacity: number }>;
    };
    const next: Record<string, { players: number; capacity: number }> = {};
    for (const map of data.maps ?? []) {
      next[map.mapId] = { players: map.players, capacity: map.capacity };
    }
    mapStatus.value = next;
  } catch {
    // Menü bleibt benutzbar — die Anzeige zeigt dann schlicht nichts.
  }
}
