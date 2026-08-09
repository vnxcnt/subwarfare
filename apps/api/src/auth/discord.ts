import type { DiscordIdentity } from '../accounts/store.js';
import { env } from '../env.js';

/**
 * Discord-OAuth (Authorization-Code-Flow, server-seitig).
 *
 * Discord ist der erste Anmeldeweg für den Produktivbetrieb, WEIL wir noch
 * keine Domain haben: Google lehnt IP-Adressen als Herkunft ab, Discord
 * akzeptiert jede exakt registrierte Redirect-URI — auch `http://<IP>/…`.
 *
 * Der Client-Secret bleibt hier auf dem Server; der Browser sieht nur den
 * Autorisierungs-Sprung und den Rücklauf mit dem Einmal-Code.
 */

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const ME_URL = 'https://discord.com/api/users/@me';

export function discordEnabled(): boolean {
  return env.discordClientId.length > 0 && env.discordClientSecret.length > 0;
}

/** Sprungadresse zu Discord. `identify` reicht — wir brauchen keine E-Mail. */
export function discordAuthorizeUrl(state: string): string {
  const query = new URLSearchParams({
    client_id: env.discordClientId,
    response_type: 'code',
    redirect_uri: env.discordRedirectUri,
    scope: 'identify',
    state,
  });
  return `${AUTHORIZE_URL}?${query}`;
}

/**
 * Löst den Einmal-Code in eine Identität auf.
 *
 * Beide Schritte (Token-Tausch, Profilabruf) mit Zeitlimit — ein hängendes
 * Discord darf keine offene Verbindung im Backend festhalten.
 */
export async function redeemDiscordCode(code: string): Promise<DiscordIdentity | null> {
  try {
    const tokenResponse = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.discordClientId,
        client_secret: env.discordClientSecret,
        grant_type: 'authorization_code',
        code,
        // Muss dem Wert aus dem Autorisierungs-Sprung entsprechen — Discord
        // prüft das als Teil des Code-Tauschs.
        redirect_uri: env.discordRedirectUri,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!tokenResponse.ok) return null;
    const token = (await tokenResponse.json()) as { access_token?: string };
    if (!token.access_token) return null;

    const meResponse = await fetch(ME_URL, {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!meResponse.ok) return null;
    const me = (await meResponse.json()) as {
      id?: string;
      username?: string;
      global_name?: string | null;
      avatar?: string | null;
    };
    if (!me.id) return null;

    return {
      discordId: me.id,
      // `global_name` ist der Anzeigename, `username` der eindeutige Handle.
      displayName: (me.global_name ?? me.username ?? 'Kapitän').slice(0, 24),
      avatarUrl: me.avatar
        ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128`
        : null,
    };
  } catch {
    return null;
  }
}
