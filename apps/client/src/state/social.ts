import type { FriendEntry, FriendsPayload, PlayerProfile } from '@subwarfare/shared';
import { ref } from 'vue';
import { API_URL, token } from './auth';

/**
 * Social-Zustand des Funkraums: Freunde, Anfragen, Profilkarte und der aktive
 * Reiter. Der Reiter lebt bewusst HIER statt in der Komponente — die
 * Profilkarte („Nachricht schreiben") und künftige Stellen sollen den
 * Funkraum gezielt auf ein Gespräch stellen können.
 */

export type SocialTab = 'hafen' | 'flottille' | 'privat' | 'freunde';

export const socialTab = ref<SocialTab>('hafen');
/** Offenes Privat-Gespräch (Konto-ID des Partners) — null = Partnerwahl. */
export const dmPartner = ref<string | null>(null);

export const friends = ref<FriendsPayload>({ friends: [], incoming: [], outgoing: [] });
export const friendsLoaded = ref(false);

/** Geöffnetes Spieler-Profil — null = keine Karte offen. */
export const profil = ref<PlayerProfile | null>(null);
export const profilBusy = ref(false);

/** Spielersuche im Freunde-Reiter. */
export const searchResults = ref<FriendEntry[]>([]);
export const searchDone = ref(false);

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

export async function refreshFriends(): Promise<void> {
  try {
    const response = await api('/social/friends');
    if (!response.ok) return;
    friends.value = (await response.json()) as FriendsPayload;
    friendsLoaded.value = true;
  } catch {
    // Liste zeigt dann den letzten Stand — Menü bleibt benutzbar.
  }
}

/** Gemeinsames Muster der Freundschafts-Aktionen: POST, Antwort übernehmen. */
async function friendAction(path: string, accountId: string): Promise<void> {
  try {
    const response = await api(path, { accountId });
    if (!response.ok) return;
    friends.value = (await response.json()) as FriendsPayload;
    friendsLoaded.value = true;
  } catch {
    // Beim nächsten refreshFriends gleicht sich der Stand wieder an.
  }
  // Offenes Profil desselben Spielers spiegelt den neuen Stand.
  if (profil.value?.accountId === accountId) await openProfile(accountId);
}

export function requestFriend(accountId: string): Promise<void> {
  return friendAction('/social/friends/request', accountId);
}

export function acceptFriend(accountId: string): Promise<void> {
  return friendAction('/social/friends/accept', accountId);
}

export function declineFriend(accountId: string): Promise<void> {
  return friendAction('/social/friends/decline', accountId);
}

export function cancelRequest(accountId: string): Promise<void> {
  return friendAction('/social/friends/cancel', accountId);
}

export function removeFriend(accountId: string): Promise<void> {
  return friendAction('/social/friends/remove', accountId);
}

/** Sucht Spieler nach Namen (Teiltreffer, ab zwei Zeichen). */
export async function searchPlayers(query: string): Promise<void> {
  const q = query.trim();
  if (q.length < 2) {
    searchResults.value = [];
    searchDone.value = false;
    return;
  }
  try {
    const response = await api(`/social/search?q=${encodeURIComponent(q)}`);
    if (!response.ok) return;
    const data = (await response.json()) as { players: FriendEntry[] };
    searchResults.value = data.players;
    searchDone.value = true;
  } catch {
    // Suche zeigt dann schlicht nichts Neues.
  }
}

/**
 * Beziehung zu einem Konto aus der geladenen Freundes-Nutzlast — steuert die
 * Knöpfe an Suchtreffern, ohne je Ergebnis ein Profil zu laden.
 */
export function beziehungZu(accountId: string): 'friends' | 'incoming' | 'outgoing' | 'none' {
  if (friends.value.friends.some((e) => e.accountId === accountId)) return 'friends';
  if (friends.value.incoming.some((e) => e.accountId === accountId)) return 'incoming';
  if (friends.value.outgoing.some((e) => e.accountId === accountId)) return 'outgoing';
  return 'none';
}

/** Öffnet die Profilkarte eines Spielers (Klick auf einen Namen). */
export async function openProfile(accountId: string): Promise<void> {
  if (profilBusy.value) return;
  profilBusy.value = true;
  try {
    const response = await api(`/social/profile/${encodeURIComponent(accountId)}`);
    if (response.ok) profil.value = (await response.json()) as PlayerProfile;
  } catch {
    // Karte bleibt zu — kein Fehlerbanner für einen Neugier-Klick.
  } finally {
    profilBusy.value = false;
  }
}

export function closeProfile(): void {
  profil.value = null;
}

/** Stellt den Funkraum auf das Privat-Gespräch mit diesem Spieler. */
export function openConversation(accountId: string): void {
  socialTab.value = 'privat';
  dmPartner.value = accountId;
  closeProfile();
}

/* --- Moderations-Werkzeuge der Profilkarte (Rolle ≥ Moderator) ----------- */

/** Löscht alle Chatnachrichten des Spielers (Server räumt + broadcastet). */
export async function modChatPurge(accountId: string): Promise<void> {
  try {
    await api('/mod/chat/purge', { accountId });
  } catch {
    // Fehlanzeige — die Karte bleibt einfach unverändert.
  }
}

/** Chatsperre setzen/aufheben; die offene Profilkarte zieht nach. */
export async function modChatMute(accountId: string, muted: boolean): Promise<void> {
  try {
    await api('/mod/chat/mute', { accountId, muted });
  } catch {
    return;
  }
  if (profil.value?.accountId === accountId) await openProfile(accountId);
}
