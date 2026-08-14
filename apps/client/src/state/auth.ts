import type { AccountProfile, AuthResponse } from '@subwarfare/shared';
import { progressionFromXp } from '@subwarfare/shared';
import { computed, ref } from 'vue';

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

/** Level, Rang und Fortschritt — abgeleitet aus dem XP-Stand des Kontos. */
export const progression = computed(() => progressionFromXp(account.value?.xp ?? 0));

/** Welche Anmeldewege der Server anbietet. Null, solange nicht geladen. */
export const authMethods = ref<{ google: boolean; discord: boolean; dev: boolean } | null>(null);

/**
 * Wiedererkennung des Browsers über den OAuth-Absprung hinweg.
 *
 * `sessionStorage` und nicht `localStorage`: der Wert gilt nur für diesen
 * Reiter und diese Sitzung. Er ist der Beweis, dass DIESER Browser den Login
 * gestartet hat — ohne ihn könnte ein Angreifer ein vorbereitetes
 * code/state-Paar unterschieben und uns in sein Konto einloggen.
 */
const NONCE_KEY = 'subwarfare:oauth-nonce';

/** Sprungadresse für den Discord-Login — eine normale Navigation, kein fetch. */
export function discordLoginUrl(): string {
  const nonce = crypto.randomUUID();
  try {
    sessionStorage.setItem(NONCE_KEY, nonce);
  } catch {
    // Gesperrter Storage: dann eben ohne Wiedererkennung — der Server prüft
    // sie nur, wenn sie im Rücklauf ankommt.
  }
  return `${API_URL}/api/auth/discord?n=${encodeURIComponent(nonce)}`;
}

/**
 * Prüft die Wiedererkennung aus dem Rücklauf und verbraucht sie.
 * `false` heißt: dieser Browser hat den Login nicht gestartet.
 */
export function consumeOauthNonce(fromServer: string | null): boolean {
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(NONCE_KEY);
    sessionStorage.removeItem(NONCE_KEY);
  } catch {
    stored = null;
  }
  // Kein Wert auf beiden Seiten: gesperrter Storage oder alter Server — dann
  // gilt der Rücklauf wie bisher. Sobald EINE Seite eine Nonce führt, muss sie
  // stimmen.
  if (stored === null && fromServer === null) return true;
  return stored !== null && stored === fromServer;
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
 * Verknüpft die Google-Identität aus dem GIS-Button mit dem ANGEMELDETEN
 * Konto. Liefert null bei Erfolg (Profil ist dann aktualisiert), sonst die
 * Fehlermeldung — „gehört schon einem anderen Konto" ist ein normaler Fall.
 */
export async function linkGoogleAccount(credential: string): Promise<string | null> {
  try {
    const response = await api('/account/link/google', {
      method: 'POST',
      body: JSON.stringify({ credential }),
    });
    const body = (await response.json().catch(() => null)) as
      | (AccountProfile & { error?: string })
      | null;
    if (!response.ok) {
      return body?.error ?? `Verknüpfen fehlgeschlagen (HTTP ${response.status}).`;
    }
    if (body) account.value = body;
    return null;
  } catch {
    return 'Server ist nicht erreichbar.';
  }
}

/**
 * Löst den Verknüpfungs-Beleg aus dem OAuth-Rücklauf ein — MIT Sitzungs-Token.
 * Erst dieser Schritt verknüpft; ein Beleg für ein fremdes Konto scheitert hier.
 */
export async function confirmDiscordLink(ticket: string): Promise<string | null> {
  try {
    const response = await api('/account/link/discord/confirm', {
      method: 'POST',
      body: JSON.stringify({ ticket }),
    });
    const body = (await response.json().catch(() => null)) as
      | (AccountProfile & { error?: string })
      | null;
    if (!response.ok) {
      return body?.error ?? `Verknüpfen fehlgeschlagen (HTTP ${response.status}).`;
    }
    if (body) account.value = body;
    return null;
  } catch {
    return 'Server ist nicht erreichbar.';
  }
}

/**
 * Startet die Discord-Verknüpfung: holt die Sprungadresse (Konto-ID steckt
 * signiert im OAuth-State) und verlässt die Seite Richtung Discord. Zurück
 * geht es ins Menü — mit `#linkticket=…`, das `confirmDiscordLink` einlöst.
 */
export async function startDiscordLink(): Promise<string | null> {
  try {
    const response = await api('/account/link/discord/start', { method: 'POST' });
    const body = (await response.json().catch(() => null)) as
      | { url?: string; error?: string }
      | null;
    if (!response.ok) {
      return body?.error ?? `Verknüpfen fehlgeschlagen (HTTP ${response.status}).`;
    }
    if (!body?.url) return 'Ungültige Antwort des Servers.';
    location.href = body.url;
    return null;
  } catch {
    return 'Server ist nicht erreichbar.';
  }
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
