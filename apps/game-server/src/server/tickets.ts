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
  | { ok: true; claims: TicketClaims; expiresAt: number }
  | { ok: false; reason: string };

/**
 * Prüft ein Join-Ticket des Backends — OHNE die `jti` zu verbrauchen.
 *
 * Geprüft werden Signatur, Ablauf und Empfänger (durch `jwtVerify`), zusätzlich
 * die Einmaligkeit über `jti`. Verbraucht wird die Kennung erst über
 * `consumeTicket`, NACHDEM alle weiteren Beitrittsprüfungen (voller Server)
 * bestanden sind: Einsatzkosten sind bei Ticketausgabe bereits bezahlt — eine
 * Abweisung nach dem Verbrennen der jti wäre ein Coin-Verlust ohne Spawn, weil
 * derselbe Spieler es innerhalb der Gültigkeit nicht erneut versuchen könnte.
 *
 * Die Empfängerprüfung ist keine Formsache: Backend und Spielserver teilen sich
 * einen Schlüssel, also wäre ohne sie auch das langlebige Sitzungs-Token aus dem
 * Browser ein gültiges Ticket — jeder Angemeldete könnte die Warteschlange
 * überspringen und beliebig oft beitreten.
 */
export async function verifyTicket(raw: unknown): Promise<TicketResult> {
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

  const { sub, name, mapId, jti, exp, role, shipModel } = payload as Record<string, unknown>;
  if (typeof sub !== 'string' || typeof jti !== 'string' || typeof mapId !== 'string') {
    return { ok: false, reason: 'Ticket unvollständig.' };
  }

  const now = Date.now();
  sweep(now);
  if (used.has(jti)) return { ok: false, reason: 'Ticket wurde bereits eingelöst.' };

  return {
    ok: true,
    // Ablaufzeit fürs spätere Verbrauchen — der used-Eintrag räumt sich damit
    // von selbst.
    expiresAt: typeof exp === 'number' ? exp * 1000 : now + 60_000,
    claims: {
      sub,
      name: typeof name === 'string' ? name : 'Unbekannt',
      mapId,
      role: typeof role === 'number' ? role : 0,
      // Fehlt im Ticket (altes Backend): kostenloser Standard. Ob die Kennung
      // ein FAHRBARES Modell ist, prüft der GameServer beim Spawn.
      shipModel: typeof shipModel === 'string' ? shipModel : 'fregatte01',
      jti,
    },
  };
}

/**
 * Verbraucht die Einmalkennung. `false`, wenn ein paralleler Handshake mit
 * demselben Ticket schneller war — synchron und damit atomar gegenüber allen
 * anderen Handshakes im selben Prozess.
 */
export function consumeTicket(jti: string, expiresAt: number): boolean {
  if (used.has(jti)) return false;
  used.set(jti, expiresAt);
  return true;
}
