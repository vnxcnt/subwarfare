import type { TicketClaims } from '@subwarfare/shared';
import { TICKET_AUDIENCE } from '@subwarfare/shared';
import { jwtVerify } from 'jose';
import { env } from '../env.js';

const secret = new TextEncoder().encode(env.jwtSecret);

/**
 * Bereits eingelöste Ticket-Kennungen mit ihrem Ablaufzeitpunkt.
 *
 * Ein Ticket gilt genau einmal. Ohne diese Sperre könnte ein abgefangenes
 * Ticket innerhalb seiner Gültigkeit beliebig oft benutzt werden.
 *
 * In-Memory ist hier ausreichend, solange EIN Spielserver läuft. Bei mehreren
 * Prozessen gehört das nach Redis — die Signatur bleibt dabei gleich.
 */
const used = new Map<string, number>();

function sweep(now: number): void {
  for (const [jti, expiresAt] of used) {
    if (expiresAt <= now) used.delete(jti);
  }
}

export type TicketResult =
  | { ok: true; claims: TicketClaims }
  | { ok: false; reason: string };

/**
 * Prüft ein Join-Ticket des Backends.
 *
 * Geprüft werden Signatur, Ablauf und Empfänger (durch `jwtVerify`), zusätzlich
 * die Einmaligkeit über `jti`.
 *
 * Die Empfängerprüfung ist keine Formsache: Backend und Spielserver teilen sich
 * einen Schlüssel, also wäre ohne sie auch das langlebige Sitzungs-Token aus dem
 * Browser ein gültiges Ticket — jeder Angemeldete könnte die Warteschlange
 * überspringen und beliebig oft beitreten.
 */
export async function redeemTicket(raw: unknown): Promise<TicketResult> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'Kein Ticket übermittelt.' };
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(raw, secret, {
      algorithms: ['HS256'],
      audience: TICKET_AUDIENCE,
    }));
  } catch {
    return { ok: false, reason: 'Ticket ungültig oder abgelaufen.' };
  }

  const { sub, name, mapId, jti, exp, role } = payload as Record<string, unknown>;
  if (typeof sub !== 'string' || typeof jti !== 'string' || typeof mapId !== 'string') {
    return { ok: false, reason: 'Ticket unvollständig.' };
  }

  const now = Date.now();
  sweep(now);
  if (used.has(jti)) return { ok: false, reason: 'Ticket wurde bereits eingelöst.' };

  // Ablaufzeit merken, damit der Eintrag später von selbst verschwindet.
  const expiresAt = typeof exp === 'number' ? exp * 1000 : now + 60_000;
  used.set(jti, expiresAt);

  return {
    ok: true,
    claims: {
      sub,
      name: typeof name === 'string' ? name : 'Unbekannt',
      mapId,
      role: typeof role === 'number' ? role : 0,
      jti,
    },
  };
}
