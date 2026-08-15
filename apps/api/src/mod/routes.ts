import type {
  ModAccountDetail,
  ModAccountSummary,
  ModItemRequest,
} from '@subwarfare/shared';
import {
  FLEET_RANK_LEADER,
  ROLE_GAMEMASTER,
  isItemId,
  progressionFromXp,
} from '@subwarfare/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Account, AccountStore } from '../accounts/store.js';
import { accountFromRequest } from '../auth/routes.js';
import type { InventoryStore } from '../economy/store.js';
import type { FleetStore } from '../fleet/store.js';
import type { WerftService } from '../werft/service.js';

/** Obergrenze fürs Bestand-Setzen — schützt vor Tippfehler-Millionen. */
const MOD_QUANTITY_MAX = 9999;

/**
 * Moderations-Routen für Gamemaster (Rolle 2) und Entwickler (Rolle 3):
 * Konten prüfen, Inventar setzen, Flottillen verwalten. Die Rolle kommt bei
 * JEDER Anfrage FRISCH aus dem Konto (nie aus dem Token) — ein Entzug wirkt
 * sofort. Jede Mutation landet im Server-Log (wer hat was an wem getan).
 */
export function registerModRoutes(
  app: FastifyInstance,
  accounts: AccountStore,
  inventory: InventoryStore,
  fleets: FleetStore,
  werft: WerftService,
): void {
  /** Angemeldetes Konto mit Moderationsrecht — sonst null. */
  async function moderator(request: FastifyRequest): Promise<Account | null> {
    const account = await accountFromRequest(request, accounts);
    if (!account || account.role < ROLE_GAMEMASTER) return null;
    return account;
  }

  function toSummary(konto: Account): ModAccountSummary {
    return {
      id: konto.id,
      displayName: konto.displayName,
      role: konto.role,
      coins: konto.coins,
      xp: konto.xp,
      level: progressionFromXp(konto.xp).level,
      kills: konto.kills,
      deaths: konto.deaths,
      createdAt: konto.createdAt,
      lastLoginAt: konto.lastLoginAt,
    };
  }

  app.get('/mod/accounts', async (request, reply) => {
    const mod = await moderator(request);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const { q } = (request.query ?? {}) as Partial<{ q: string }>;
    const query = typeof q === 'string' ? q.trim().slice(0, 24) : '';
    if (query.length < 2) return { accounts: [] };
    const treffer = await accounts.searchByName(query, 20);
    return { accounts: treffer.map(toSummary) };
  });

  app.get('/mod/accounts/:accountId', async (request, reply) => {
    const mod = await moderator(request);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const { accountId } = request.params as { accountId: string };
    const konto = await accounts.byId(accountId);
    if (!konto) return reply.code(404).send({ error: 'Konto nicht gefunden.' });

    const [items, ships, membership] = await Promise.all([
      inventory.items(konto.id),
      werft.list(konto.id),
      fleets.membership(konto.id),
    ]);
    let fleet: ModAccountDetail['fleet'] = null;
    if (membership) {
      const profil = await fleets.profile(membership.fleetId);
      if (profil) fleet = { id: profil.fleet.id, name: profil.fleet.name, rank: membership.rank };
    }

    const detail: ModAccountDetail = {
      ...toSummary(konto),
      hasGoogle: konto.googleSub !== null,
      hasDiscord: konto.discordId !== null,
      items,
      ships: ships.map((ship) => ({
        shipId: ship.id,
        model: ship.model,
        hp: ship.hp,
        maxHp: werft.maxHp(ship.model),
        repairUntil: ship.repairUntil === null ? null : ship.repairUntil.toISOString(),
        repairSecondsLeft:
          ship.repairUntil === null
            ? null
            : Math.max(0, Math.ceil((ship.repairUntil.getTime() - Date.now()) / 1000)),
        perks: ship.perks,
      })),
      fleet,
    };
    return detail;
  });

  /*
   * Bestand ABSOLUT setzen (0 entfernt) — das Moderations-Gegenstück zum
   * Shop. Läuft am Kauf-Weg vorbei, deshalb Protokollzeile mit Täter.
   */
  app.post('/mod/items', async (request, reply) => {
    const mod = await moderator(request);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const { accountId, itemId, quantity } = (request.body ?? {}) as Partial<ModItemRequest>;
    if (typeof accountId !== 'string' || accountId.length === 0) {
      return reply.code(400).send({ error: 'Konto fehlt.' });
    }
    if (!isItemId(itemId)) return reply.code(400).send({ error: 'Unbekanntes Item.' });
    if (
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity < 0 ||
      quantity > MOD_QUANTITY_MAX
    ) {
      return reply.code(400).send({ error: `Stückzahl: 0 bis ${MOD_QUANTITY_MAX}.` });
    }
    const ziel = await accounts.byId(accountId);
    if (!ziel) return reply.code(404).send({ error: 'Konto nicht gefunden.' });

    await inventory.setQuantity(ziel.id, itemId, quantity);
    console.log(
      `[mod] ${mod.displayName} (${mod.id}) setzt ${itemId} = ${quantity} bei ${ziel.displayName} (${ziel.id}).`,
    );
    return { items: await inventory.items(ziel.id) };
  });

  app.get('/mod/fleets', async (request, reply) => {
    const mod = await moderator(request);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const { q } = (request.query ?? {}) as Partial<{ q: string }>;
    const query = typeof q === 'string' ? q.trim().slice(0, 30) : '';
    return { fleets: await fleets.search(query, 20) };
  });

  app.get('/mod/fleets/:fleetId', async (request, reply) => {
    const mod = await moderator(request);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const { fleetId } = request.params as { fleetId: string };
    const profil = await fleets.profile(fleetId);
    if (!profil) return reply.code(404).send({ error: 'Flottille nicht gefunden.' });
    return profil;
  });

  /*
   * Mitglied entfernen — die Moderation steht über den Spieler-Rechten,
   * NUR der Kommandant ist ausgenommen: ohne ihn bliebe die Flottille
   * führungslos zurück. Der Weg dafür ist die Auflösung.
   */
  app.post('/mod/fleets/kick', async (request, reply) => {
    const mod = await moderator(request);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const { fleetId, accountId } = (request.body ?? {}) as Partial<{
      fleetId: string;
      accountId: string;
    }>;
    if (typeof fleetId !== 'string' || typeof accountId !== 'string') {
      return reply.code(400).send({ error: 'Flottille und Konto erwartet.' });
    }
    const profil = await fleets.profile(fleetId);
    const mitglied = profil?.members.find((eintrag) => eintrag.accountId === accountId);
    if (!profil || !mitglied) {
      return reply.code(404).send({ error: 'Mitglied nicht gefunden.' });
    }
    if (mitglied.rank === FLEET_RANK_LEADER) {
      return reply
        .code(409)
        .send({ error: 'Der Kommandant kann nicht entlassen werden — Flottille auflösen.' });
    }
    await fleets.kick(fleetId, accountId);
    console.log(
      `[mod] ${mod.displayName} (${mod.id}) entlässt ${mitglied.displayName} aus ${profil.fleet.name}.`,
    );
    return { fleet: await fleets.profile(fleetId) };
  });

  app.post('/mod/fleets/disband', async (request, reply) => {
    const mod = await moderator(request);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const { fleetId } = (request.body ?? {}) as Partial<{ fleetId: string }>;
    if (typeof fleetId !== 'string' || fleetId.length === 0) {
      return reply.code(400).send({ error: 'Flottille fehlt.' });
    }
    const profil = await fleets.profile(fleetId);
    if (!profil) return reply.code(404).send({ error: 'Flottille nicht gefunden.' });
    await fleets.disband(fleetId);
    console.log(
      `[mod] ${mod.displayName} (${mod.id}) löst ${profil.fleet.name} auf (${profil.members.length} Mitglieder).`,
    );
    return { ok: true };
  });
}
