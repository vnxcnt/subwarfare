import type { LoadoutEntryStack, TicketClaims } from '@subwarfare/shared';
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

/** Formprüfung eines Munitionspostens aus dem Ticket. */
function istPosten(wert: unknown): wert is LoadoutEntryStack {
  if (typeof wert !== 'object' || wert === null) return false;
  const posten = wert as { weapon?: unknown; itemId?: unknown; count?: unknown };
  return (
    typeof posten.weapon === 'string' &&
    typeof posten.itemId === 'string' &&
    typeof posten.count === 'number' &&
    Number.isFinite(posten.count) &&
    posten.count > 0
  );
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

  const { sub, name, mapId, jti, exp, role, shipModel, armorItem, loadout } = payload as Record<
    string,
    unknown
  >;
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
      // Fehlt oder unbekannt: ungepanzert. Der Panzerungskatalog entscheidet
      // beim Spawn, ob die Kennung Absorption trägt — eine erfundene Kennung
      // findet dort nichts und wirkt damit wie keine.
      armorItem: typeof armorItem === 'string' ? armorItem : null,
      // Munition dieses Einsatzes. Die api hat sie bereits abgebucht; hier
      // wird nur noch geprüft, dass die Form stimmt — eine kaputte Zeile
      // bedeutet „diese Waffe nicht dabei", nicht „Ticket ungültig".
      loadout: Array.isArray(loadout) ? loadout.filter(istPosten) : [],
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

/**
 * Bereits eingelöste Kennungen — für den Statusbericht ans Backend.
 *
 * Das Backend hält nach der Ticketausgabe eine Reservierung und stellt dasselbe
 * Ticket erneut zu, solange sie steht (Doppelklick, zweiter Reiter). Ob es
 * inzwischen VERBRAUCHT ist, weiß nur diese Liste: an den verbundenen Konten
 * ist das nicht abzulesen, sobald jemand wieder ausgestiegen ist.
 *
 * Vorher sweepen, damit nichts Abgelaufenes gemeldet wird; die Liste ist durch
 * die kurze Ticket-Gültigkeit von Natur aus klein.
 */
export function redeemedTickets(): string[] {
  sweep(Date.now());
  return [...used.keys()];
}
