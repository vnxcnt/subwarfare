import type { FastifyInstance } from 'fastify';
import {
  FLEET_DESCRIPTION_MAX,
  FLEET_MIN_LEVEL,
  FLEET_RANK_LEADER,
  canAssignRank,
  canKick,
  isFleetRank,
  normalizeFleetName,
  progressionFromXp,
} from '@subwarfare/shared';
import type { Account, AccountStore } from '../accounts/store.js';
import { accountFromRequest } from '../auth/routes.js';
import type { FleetStore } from './store.js';

/**
 * Flottillen-Routen. Rechte-Entscheidungen laufen ausschließlich über die
 * shared-Helfer (canAssignRank/canKick) — dieselben Funktionen, mit denen der
 * Client seine Knöpfe zeigt. Der Store liefert nur Primitive.
 *
 * Level-Schranke: ab FLEET_MIN_LEVEL. Dev-Konten sind ausgenommen — solange
 * es keine XP-Vergabe gibt, wäre die Schranke sonst für alle zu, und die
 * Test-Umgebung könnte das Feature nie sehen.
 */
export function registerFleetRoutes(
  app: FastifyInstance,
  accounts: AccountStore,
  fleets: FleetStore,
): void {
  function levelOk(account: Account): boolean {
    return account.isDev || progressionFromXp(account.xp).level >= FLEET_MIN_LEVEL;
  }

  /** Beschreibung säubern: Steuerzeichen raus, Länge deckeln, leer = null. */
  function cleanDescription(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const text = raw.replace(/\p{C}/gu, '').trim().slice(0, FLEET_DESCRIPTION_MAX);
    return text.length > 0 ? text : null;
  }

  app.get('/fleet/mine', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    return { mine: await fleets.mine(account.id) };
  });

  app.get('/fleet/search', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    const { q } = (request.query ?? {}) as Partial<{ q: string }>;
    const query = typeof q === 'string' ? q.trim().slice(0, 30) : '';
    return { fleets: await fleets.search(query, 20) };
  });

  app.post('/fleet/create', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    if (!levelOk(account)) {
      return reply.code(403).send({ error: `Flottillen stehen ab Level ${FLEET_MIN_LEVEL} offen.` });
    }

    const body = (request.body ?? {}) as Partial<{ name: string; description: string }>;
    const name = normalizeFleetName(body.name);
    if (!name) return reply.code(400).send({ error: 'Name: 3 bis 30 Zeichen.' });

    const result = await fleets.create(account.id, name, cleanDescription(body.description));
    if (result === 'name_taken') {
      return reply.code(409).send({ error: 'Diesen Flottillen-Namen gibt es bereits.' });
    }
    if (result === 'already_member') {
      return reply.code(409).send({ error: 'Du gehörst bereits einer Flottille an.' });
    }
    return { mine: result };
  });

  app.post('/fleet/join', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    if (!levelOk(account)) {
      return reply.code(403).send({ error: `Flottillen stehen ab Level ${FLEET_MIN_LEVEL} offen.` });
    }

    const { fleetId } = (request.body ?? {}) as Partial<{ fleetId: string }>;
    if (typeof fleetId !== 'string' || fleetId.length === 0) {
      return reply.code(400).send({ error: 'Flottille fehlt.' });
    }

    const result = await fleets.join(account.id, fleetId);
    if (result === 'already_member') {
      return reply.code(409).send({ error: 'Du gehörst bereits einer Flottille an.' });
    }
    if (result === 'not_found') {
      return reply.code(404).send({ error: 'Diese Flottille gibt es nicht mehr.' });
    }
    return { mine: await fleets.mine(account.id) };
  });

  app.post('/fleet/leave', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });

    const result = await fleets.leave(account.id);
    if (result === 'not_member') {
      return reply.code(409).send({ error: 'Du gehörst keiner Flottille an.' });
    }
    if (result === 'leader_must_transfer') {
      return reply
        .code(409)
        .send({ error: 'Übergib erst das Kommando — die Flottille braucht einen Kommandanten.' });
    }
    return { mine: null };
  });

  app.post('/fleet/rank', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });

    const body = (request.body ?? {}) as Partial<{ accountId: string; rank: number }>;
    if (typeof body.accountId !== 'string' || !isFleetRank(body.rank)) {
      return reply.code(400).send({ error: 'Ungültige Rang-Anweisung.' });
    }
    if (body.accountId === account.id) {
      return reply.code(400).send({ error: 'Den eigenen Rang vergibt man nicht selbst.' });
    }

    const actor = await fleets.membership(account.id);
    const target = await fleets.membership(body.accountId);
    if (!actor || !target || actor.fleetId !== target.fleetId) {
      return reply.code(404).send({ error: 'Kein gemeinsames Flottillen-Mitglied.' });
    }
    if (!canAssignRank(actor.rank, target.rank, body.rank)) {
      return reply.code(403).send({ error: 'Dafür fehlen dir die Befugnisse.' });
    }

    await fleets.setRank(actor.fleetId, body.accountId, body.rank);
    // Kommando-Übergabe: es gibt genau EINEN Kommandanten — wer Rang 1
    // vergibt, tritt selbst auf Rang 2 zurück.
    if (body.rank === FLEET_RANK_LEADER) {
      await fleets.setRank(actor.fleetId, account.id, 2);
    }
    return { mine: await fleets.mine(account.id) };
  });

  app.post('/fleet/kick', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });

    const { accountId } = (request.body ?? {}) as Partial<{ accountId: string }>;
    if (typeof accountId !== 'string' || accountId.length === 0 || accountId === account.id) {
      return reply.code(400).send({ error: 'Ungültige Entlassung.' });
    }

    const actor = await fleets.membership(account.id);
    const target = await fleets.membership(accountId);
    if (!actor || !target || actor.fleetId !== target.fleetId) {
      return reply.code(404).send({ error: 'Kein gemeinsames Flottillen-Mitglied.' });
    }
    if (!canKick(actor.rank, target.rank)) {
      return reply.code(403).send({ error: 'Dafür fehlen dir die Befugnisse.' });
    }

    await fleets.kick(actor.fleetId, accountId);
    return { mine: await fleets.mine(account.id) };
  });

  app.post('/fleet/donate', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });

    const { amount } = (request.body ?? {}) as Partial<{ amount: number }>;
    const betrag = typeof amount === 'number' ? Math.trunc(amount) : 0;
    if (betrag < 1 || betrag > 1_000_000) {
      return reply.code(400).send({ error: 'Ungültiger Betrag.' });
    }

    const membership = await fleets.membership(account.id);
    if (!membership) return reply.code(409).send({ error: 'Du gehörst keiner Flottille an.' });

    // Erst abbuchen (atomar gegen das Guthaben), dann gutschreiben — schlägt
    // die Gutschrift theoretisch fehl, fehlt Geld in der Kasse, aber es
    // entsteht keines aus dem Nichts.
    if (!(await accounts.spendCoins(account.id, betrag))) {
      return reply.code(409).send({ error: 'Nicht genug Coins.' });
    }
    await fleets.addToTreasury(membership.fleetId, betrag);

    const fresh = await accounts.byId(account.id);
    return { coins: fresh?.coins ?? 0, mine: await fleets.mine(account.id) };
  });
}
