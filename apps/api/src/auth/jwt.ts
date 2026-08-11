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

/**
 * Ohne `linkAccountId` ist der Rücksprung ein LOGIN (Konto suchen/anlegen),
 * mit ist er eine VERKNÜPFUNG: die Discord-Identität wird an genau dieses
 * Konto gehängt.
 *
 * `nonce` ist eine Zufallszahl, die der CLIENT vor dem Absprung erzeugt und
 * in `sessionStorage` behält; sie läuft signiert durch und kommt im Rücklauf
 * wieder mit. Ohne sie wäre der Login CSRF-anfällig: ein Angreifer könnte ein
 * eigenes, gültiges code/state-Paar vorbereiten und ein Opfer auf den Callback
 * locken — das Opfer wäre danach im KONTO DES ANGREIFERS angemeldet. Die Nonce
 * kennt nur der Browser, der den Absprung gestartet hat.
 */
export async function signOauthState(options?: {
  linkAccountId?: string;
  nonce?: string;
}): Promise<string> {
  const claims: Record<string, string> = {};
  if (options?.linkAccountId) claims['link'] = options.linkAccountId;
  if (options?.nonce) claims['nonce'] = options.nonce;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(STATE_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(secret);
}

export interface OauthStateResult {
  valid: boolean;
  /** Konto, an das verknüpft werden soll — null bei normalem Login. */
  linkAccountId: string | null;
  /** Wiedererkennungswert des startenden Browsers — null, wenn keiner gesetzt war. */
  nonce: string | null;
}

export async function verifyOauthState(state: unknown): Promise<OauthStateResult> {
  if (typeof state !== 'string' || state.length === 0) {
    return { valid: false, linkAccountId: null, nonce: null };
  }
  try {
    const { payload } = await jwtVerify(state, secret, {
      algorithms: ['HS256'],
      audience: STATE_AUDIENCE,
    });
    const { link, nonce } = payload as { link?: unknown; nonce?: unknown };
    return {
      valid: true,
      linkAccountId: typeof link === 'string' ? link : null,
      nonce: typeof nonce === 'string' ? nonce : null,
    };
  } catch {
    return { valid: false, linkAccountId: null, nonce: null };
  }
}

/**
 * Empfänger-Kennung des VERKNÜPFUNGS-Belegs.
 *
 * Der OAuth-Rücklauf verknüpft NICHT selbst: er stellt nur einen kurzlebigen,
 * signierten Beleg über die geprüfte Fremd-Identität aus. Erst der Client löst
 * ihn mit seinem Sitzungs-Token ein — und die api verknüpft nur, wenn der Beleg
 * auf dasselbe Konto lautet wie die Sitzung.
 *
 * Das schließt die Übernahme-Lücke des naiven Wegs: dort hätte ein Angreifer
 * einen Verknüpfungs-State für SEIN Konto erzeugen, dem Opfer unterschieben und
 * damit dessen Discord-Identität an sein eigenes Konto binden können. Ein Beleg
 * für ein fremdes Konto ist in der Sitzung des Opfers wertlos.
 */
const LINK_AUDIENCE = 'subwarfare:link';

export interface LinkTicketClaims {
  /** Konto, das verknüpft werden soll. */
  sub: string;
  provider: 'discord';
  /** Fremd-Kennung (Discord-Snowflake). */
  externalId: string;
  displayName: string;
  avatarUrl: string | null;
}

export async function signLinkTicket(claims: LinkTicketClaims): Promise<string> {
  return new SignJWT({
    provider: claims.provider,
    externalId: claims.externalId,
    name: claims.displayName,
    avatar: claims.avatarUrl,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setAudience(LINK_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt()
    // Kurz: der Client löst ihn unmittelbar nach dem Rücksprung ein.
    .setExpirationTime('120s')
    .sign(secret);
}

export async function verifyLinkTicket(raw: unknown): Promise<LinkTicketClaims | null> {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const { payload } = await jwtVerify(raw, secret, {
      algorithms: ['HS256'],
      audience: LINK_AUDIENCE,
    });
    const { sub, provider, externalId, name, avatar } = payload as Record<string, unknown>;
    if (typeof sub !== 'string' || provider !== 'discord' || typeof externalId !== 'string') {
      return null;
    }
    return {
      sub,
      provider: 'discord',
      externalId,
      displayName: typeof name === 'string' ? name : 'Kapitän',
      avatarUrl: typeof avatar === 'string' ? avatar : null,
    };
  } catch {
    return null;
  }
}
