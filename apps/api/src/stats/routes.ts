import type { FastifyInstance } from 'fastify';
import type { StatsEvent, StatsLeaderboardResponse } from '@subwarfare/shared';
import { LEADERBOARD_LIMIT, XP_REWARDS } from '@subwarfare/shared';
import type { AccountStore } from '../accounts/store.js';
import { accountFromRequest } from '../auth/routes.js';
import { env } from '../env.js';

/**
 * Statistik-Routen: Bestenlisten für das Hauptmenü und der interne
 * Ereignis-Kanal des Spielservers.
 *
 * Die XP-Beträge rechnet AUSSCHLIESSLICH diese Seite (aus XP_REWARDS) — der
 * Spielserver meldet nur Ereignis-Typen. So gibt es genau eine Quelle für die
 * Zahlen, und der Meldeweg kann nie falsche Beträge tragen.
 */
export function registerStatsRoutes(app: FastifyInstance, accounts: AccountStore): void {
  // Öffentlich (Session-Auth): Top 20 je Liste, frisch bei jedem Abruf —
  // die Abfrage läuft nur beim Öffnen des Menüpunkts, ein Cache lohnt nicht.
  app.get('/stats/leaderboard', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    const [pvp, xp] = await Promise.all([
      accounts.topPvp(LEADERBOARD_LIMIT),
      accounts.topXp(LEADERBOARD_LIMIT),
    ]);
    return { pvp, xp } satisfies StatsLeaderboardResponse;
  });

  /*
   * Kampf-/Fortschritts-Ereignisse vom Spielserver. Der interne Schlüssel ist
   * die ganze Absicherung — ein Client könnte sich hierüber sonst XP und
   * Kills herbeischreiben (gleiche Regel wie /internal/sortie-end).
   */
  app.post('/internal/stats', async (request, reply) => {
    if (request.headers['x-internal-key'] !== env.internalKey) {
      return reply.code(403).send({ error: 'Kein Zugriff.' });
    }
    const body = (request.body ?? {}) as { events?: unknown };
    if (!Array.isArray(body.events)) {
      return reply.code(400).send({ error: 'events erwartet.' });
    }

    // Deckel 100: ein Simulationsschritt versenkt nie mehr — alles darüber
    // wäre ein Fehler drüben, kein Grund für eine Endlosschleife hier.
    for (const raw of body.events.slice(0, 100)) {
      const event = raw as Partial<StatsEvent> & { killerId?: unknown; victimId?: unknown; accountId?: unknown };
      try {
        if (
          event.type === 'pvp_kill' &&
          typeof event.killerId === 'string' &&
          typeof event.victimId === 'string' &&
          // Selbst-Kill zählt nie — der Spielserver filtert schon, aber die
          // Invariante soll unabhängig von der Gegenseite gelten.
          event.killerId !== event.victimId
        ) {
          // Death aus DEMSELBEN Ereignis wie der Kill: „Tod nur, wenn der
          // Killer ein Spieler war" ist damit strukturell erzwungen.
          await accounts.recordPvpKill(event.killerId);
          await accounts.addXp(event.killerId, XP_REWARDS.playerKill);
          await accounts.recordPvpDeath(event.victimId);
        } else if (event.type === 'npc_kill' && typeof event.accountId === 'string') {
          await accounts.addXp(event.accountId, XP_REWARDS.npcKill);
        } else if (event.type === 'extraction' && typeof event.accountId === 'string') {
          await accounts.addXp(event.accountId, XP_REWARDS.extraction);
        }
        // Unbekannte Konto-IDs laufen als UPDATE mit 0 Zeilen still ins
        // Leere — gewollt (Konto gelöscht zwischen Kill und Meldung).
      } catch (error) {
        console.error('[api] Statistik-Ereignis fehlgeschlagen:', error);
      }
    }
    return { ok: true };
  });
}
