import type { AccountProfile, AuthResponse } from '@subwarfare/shared';
import { ref } from 'vue';

/**
 * Anmeldezustand.
 *
 * Das Sitzungs-Token liegt in `localStorage` und überlebt Neuladen und
 * Browserneustart — die Sitzung gilt serverseitig sieben Tage. Das Profil
 * dagegen wird bei jedem Start frisch über `/auth/me` geholt: es ist nur die
 * Anzeige, und eine veraltete Kopie im Speicher wäre eine zweite Wahrheit.
 */

const TOKEN_KEY = 'subwarfare:session';

/**
 * Basis-URL des Backends. Leer bedeutet gleiche Herkunft — auf dem VPS liefert
 * der Reverse-Proxy Client und Backend unter einer Adresse aus. Lokal zeigt
 * `VITE_API_URL` auf den getrennten Port.
 */
export const API_URL: string = import.meta.env.VITE_API_URL ?? '';

export const token = ref<string | null>(readStoredToken());
export const account = ref<AccountProfile | null>(null);

/** Welche Anmeldewege der Server anbietet. Null, solange nicht geladen. */
export const authMethods = ref<{ google: boolean; discord: boolean; dev: boolean } | null>(null);

/** Sprungadresse für den Discord-Login — eine normale Navigation, kein fetch. */
export function discordLoginUrl(): string {
  return `${API_URL}/api/auth/discord`;
}

/**
 * Übernimmt ein Sitzungs-Token, das der OAuth-Rücklauf im URL-Fragment
 * übergeben hat. Das Profil holt danach `restoreSession()` — das Token allein
 * ist noch kein Beweis, dass der Server es (noch) anerkennt.
 */
export function adoptToken(value: string): void {
  storeToken(value);
}

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Privater Modus mit gesperrtem Storage — dann eben nur für diese Sitzung.
    return null;
  }
}

function storeToken(value: string | null): void {
  token.value = value;
  try {
    if (value === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, value);
  } catch {
    // Siehe oben — Speichern ist wünschenswert, nicht Bedingung.
  }
}

export function isLoggedIn(): boolean {
  return token.value !== null;
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (token.value) headers.set('authorization', `Bearer ${token.value}`);
  if (init?.body) headers.set('content-type', 'application/json');
  // Alle HTTP-Routen des Backends liegen unter /api — siehe apps/api/src/index.ts.
  return fetch(`${API_URL}/api${path}`, { ...init, headers });
}

export async function loadAuthMethods(): Promise<void> {
  try {
    const response = await api('/auth/methods');
    if (response.ok) authMethods.value = await response.json();
  } catch {
    authMethods.value = null;
  }
}

/**
 * Prüft ein vorhandenes Token gegen den Server.
 *
 * Wirft nie: Ergebnis ist „angemeldet oder nicht". Ein abgelaufenes oder
 * fremdes Token wird dabei verworfen, sonst bliebe der Client in einem
 * Zustand hängen, in dem er sich angemeldet glaubt und jede Anfrage scheitert.
 */
export async function restoreSession(): Promise<boolean> {
  if (!token.value) return false;
  try {
    const response = await api('/auth/me');
    if (!response.ok) {
      if (response.status === 401) storeToken(null);
      return false;
    }
    account.value = await response.json();
    return true;
  } catch {
    // Server nicht erreichbar: Token behalten, aber nicht als angemeldet gelten.
    return false;
  }
}

async function handleAuthResponse(response: Response): Promise<string | null> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return body?.error ?? `Anmeldung fehlgeschlagen (HTTP ${response.status}).`;
  }
  const data = (await response.json()) as AuthResponse;
  storeToken(data.token);
  account.value = data.account;
  return null;
}

/** Entwickler-Anmeldung. Liefert null bei Erfolg, sonst die Fehlermeldung. */
export async function loginDev(name: string): Promise<string | null> {
  try {
    return await handleAuthResponse(
      await api('/auth/dev', { method: 'POST', body: JSON.stringify({ name }) }),
    );
  } catch {
    return 'Server ist nicht erreichbar.';
  }
}

/** Google-Anmeldung mit dem ID-Token aus dem GIS-Button. */
export async function loginGoogle(credential: string): Promise<string | null> {
  try {
    return await handleAuthResponse(
      await api('/auth/google', { method: 'POST', body: JSON.stringify({ credential }) }),
    );
  } catch {
    return 'Server ist nicht erreichbar.';
  }
}

export function logout(): void {
  storeToken(null);
  account.value = null;
}

/**
 * Löscht das Konto endgültig auf dem Server und meldet lokal ab.
 * Liefert null bei Erfolg, sonst die Fehlermeldung — die BESTÄTIGUNG davor
 * ist Sache der Oberfläche, hier wird nur noch ausgeführt.
 */
export async function deleteAccount(): Promise<string | null> {
  try {
    const response = await api('/account', { method: 'DELETE' });
    // 401 heißt hier: das Konto existiert bereits nicht mehr (z. B. in einem
    // zweiten Tab gelöscht). Das GEWÜNSCHTE Ergebnis ist eingetreten — lokal
    // abmelden statt eine verwirrende Fehlermeldung zu zeigen.
    if (!response.ok && response.status !== 401) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      return body?.error ?? `Löschen fehlgeschlagen (HTTP ${response.status}).`;
    }
    logout();
    return null;
  } catch {
    return 'Server ist nicht erreichbar.';
  }
}
