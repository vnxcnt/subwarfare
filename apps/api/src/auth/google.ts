import { OAuth2Client } from 'google-auth-library';
import { env } from '../env.js';
import type { GoogleIdentity } from '../accounts/store.js';

const client = env.googleClientId ? new OAuth2Client(env.googleClientId) : null;

export function googleEnabled(): boolean {
  return client !== null;
}

/**
 * Prüft ein Google-ID-Token aus dem Browser.
 *
 * `verifyIdToken` prüft Signatur, Aussteller, Ablauf **und** die
 * Empfänger-Kennung gegen unsere Client-ID. Letzteres ist der Punkt, der
 * zählt: ohne `audience` wäre jedes beliebige Google-Token gültig, auch eines,
 * das für eine ganz andere Anwendung ausgestellt wurde.
 *
 * Schlüssel ist `sub` — Googles unveränderliche Nutzerkennung. Die Mailadresse
 * eignet sich nicht dafür, sie kann wechseln.
 */
export async function verifyGoogleCredential(credential: unknown): Promise<GoogleIdentity | null> {
  if (!client || typeof credential !== 'string' || credential.length === 0) return null;

  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: env.googleClientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub) return null;

    // Unbestätigte Adressen nicht übernehmen — sonst steht im Konto eine
    // Adresse, die dem Nutzer gar nicht gehört.
    const email = payload.email_verified === true ? (payload.email ?? null) : null;

    return {
      googleSub: payload.sub,
      email,
      displayName: payload.name?.slice(0, 24) ?? payload.given_name?.slice(0, 24) ?? 'Kapitän',
      avatarUrl: payload.picture ?? null,
    };
  } catch {
    return null;
  }
}
