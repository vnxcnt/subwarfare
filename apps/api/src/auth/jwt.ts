import type { SessionClaims, TicketClaims } from '@subwarfare/shared';
import { SESSION_AUDIENCE, TICKET_AUDIENCE } from '@subwarfare/shared';
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { env } from '../env.js';

const secret = new TextEncoder().encode(env.jwtSecret);

/**
 * Zwei Tokenarten mit demselben Schlüssel, aber gegensätzlicher Lebensdauer:
 *
 * - **Sitzung** (Tage): weist den Spieler gegenüber diesem Backend aus.
 * - **Join-Ticket** (Sekunden, einmalig): weist ihn gegenüber dem Spielserver
 *   aus. Kurz, weil es über den Client läuft und dort abgefangen werden könnte.
 *
 * Getrennt gehalten werden sie über `aud` — siehe `SESSION_AUDIENCE`.
 */

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ name: claims.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.sessionDays}d`)
    .sign(secret);
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
      audience: SESSION_AUDIENCE,
    });
    const { sub, name } = payload;
    if (typeof sub !== 'string') return null;
    return { sub, name: typeof name === 'string' ? name : 'Unbekannt' };
  } catch {
    return null;
  }
}

export async function signTicket(claims: Omit<TicketClaims, 'jti'>): Promise<string> {
  return new SignJWT({
    name: claims.name,
    mapId: claims.mapId,
    role: claims.role,
    shipModel: claims.shipModel,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setAudience(TICKET_AUDIENCE)
    // Einmalkennung: der Spielserver merkt sie sich und lehnt eine zweite
    // Einlösung ab.
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${env.ticketTtl}s`)
    .sign(secret);
}

/**
 * `state`-Parameter für OAuth-Umleitungen (Discord).
 *
 * Signiert statt gespeichert: der Rücksprung muss von UNS angestoßen worden
 * sein, sonst könnte jeder beliebige Callback-Aufrufe mit fremden Codes
 * konstruieren. Eigene Empfänger-Kennung, damit ein State-Token niemals als
 * Sitzung oder Ticket durchgeht — dieselbe Trennung wie zwischen den beiden.
 */
const STATE_AUDIENCE = 'subwarfare:oauth-state';

export async function signOauthState(): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(STATE_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(secret);
}

export async function verifyOauthState(state: unknown): Promise<boolean> {
  if (typeof state !== 'string' || state.length === 0) return false;
  try {
    await jwtVerify(state, secret, { algorithms: ['HS256'], audience: STATE_AUDIENCE });
    return true;
  } catch {
    return false;
  }
}
