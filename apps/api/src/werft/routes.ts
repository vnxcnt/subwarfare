import type {
  WerftMutationResponse,
  WerftPayload,
  WerftShip,
} from '@subwarfare/shared';
import {
  SHIP_SLOTS,
  isPlayableModel,
  validatePerkSet,
} from '@subwarfare/shared';
import type { FastifyInstance } from 'fastify';
import type { AccountStore } from '../accounts/store.js';
import { accountFromRequest } from '../auth/routes.js';
import type { InventoryStore } from '../economy/store.js';
import { env } from '../env.js';
import type { AccountShip } from './store.js';
import type { WerftService } from './service.js';

/**
 * Werft-Routen: Flotte lesen, Schiffe kaufen, reparieren, Perks verbauen —
 * plus der interne Schadenskanal des Spielservers. Preise und Formeln kommen
 * aus shared; der Client schickt nur Kennungen.
 */
export function registerWerftRoutes(
  app: FastifyInstance,
  accounts: AccountStore,
  inventory: InventoryStore,
  werft: WerftService,
): void {
  function toWire(ship: AccountShip): WerftShip {
    const left =
      ship.repairUntil === null
        ? null
        : Math.max(0, Math.ceil((ship.repairUntil.getTime() - Date.now()) / 1000));
    return {
      shipId: ship.id,
      model: ship.model,
      hp: ship.hp,
      maxHp: werft.maxHp(ship.model),
      repairUntil: ship.repairUntil === null ? null : ship.repairUntil.toISOString(),
      repairSecondsLeft: left,
      perks: ship.perks,
    };
  }

  async function mutationResponse(accountId: string): Promise<WerftMutationResponse> {
    const [konto, ships] = await Promise.all([accounts.byId(accountId), werft.list(accountId)]);
    return { coins: konto?.coins ?? 0, ships: ships.map(toWire) };
  }

  app.get('/werft', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    const ships = await werft.list(account.id);
    const payload: WerftPayload = {
      slots: SHIP_SLOTS,
      ships: ships.map(toWire),
      catalog: werft.catalog(),
    };
    return payload;
  });

  app.post('/werft/buy', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    const { model } = (request.body ?? {}) as Partial<{ model: string }>;
    if (!isPlayableModel(model)) return reply.code(400).send({ error: 'Unbekanntes Schiff.' });

    const result = await werft.buy(account.id, model);
    if (result === 'full') {
      return reply.code(409).send({ error: `Alle ${SHIP_SLOTS} Slots sind belegt.` });
    }
    if (result === 'poor') return reply.code(409).send({ error: 'Nicht genug Coins.' });
    return mutationResponse(account.id);
  });

  app.post('/werft/repair', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    const { shipId } = (request.body ?? {}) as Partial<{ shipId: string }>;
    if (typeof shipId !== 'string' || shipId.length === 0) {
      return reply.code(400).send({ error: 'Schiff fehlt.' });
    }

    const result = await werft.repair(account.id, shipId);
    if (result === 'notfound') return reply.code(404).send({ error: 'Schiff nicht gefunden.' });
    if (result === 'busy') return reply.code(409).send({ error: 'Wird bereits repariert.' });
    if (result === 'intact') return reply.code(409).send({ error: 'Schiff ist unbeschädigt.' });
    if (result === 'atsea') return reply.code(409).send({ error: 'Schiff ist gerade im Einsatz.' });
    if (result === 'poor') return reply.code(409).send({ error: 'Nicht genug Coins.' });
    return mutationResponse(account.id);
  });

  /*
   * Verschrotten — endgültig und OHNE Erstattung (auch nicht anteilig; das
   * ist die Spielregel, der Client verlangt dafür die getippte Bestätigung).
   * Der Server prüft nur Besitz und See-Status; die Bestätigung ist UX.
   */
  app.post('/werft/scrap', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    const { shipId } = (request.body ?? {}) as Partial<{ shipId: string }>;
    if (typeof shipId !== 'string' || shipId.length === 0) {
      return reply.code(400).send({ error: 'Schiff fehlt.' });
    }
    const result = await werft.scrap(account.id, shipId);
    if (result === 'notfound') return reply.code(404).send({ error: 'Schiff nicht gefunden.' });
    if (result === 'atsea') return reply.code(409).send({ error: 'Schiff ist gerade im Einsatz.' });
    return mutationResponse(account.id);
  });

  app.post('/werft/perks', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    const { shipId, perks } = (request.body ?? {}) as Partial<{ shipId: string; perks: unknown }>;
    if (typeof shipId !== 'string' || shipId.length === 0) {
      return reply.code(400).send({ error: 'Schiff fehlt.' });
    }
    const ship = await werft.shipOf(account.id, shipId);
    if (!ship) return reply.code(404).send({ error: 'Schiff nicht gefunden.' });
    /*
     * Slot-Zahl aus dem Katalog (ships.perk_slots) — nicht aus dem Code.
     * SCHRUMPFEN ist auch über dem Limit erlaubt: senkt ein Entwickler
     * perk_slots unter eine Bestands-Beladung, muss der Besitzer den
     * Überhang noch ausbauen können — sonst wäre jede Änderung für immer
     * ungültig (Deadlock). Wachsen oder Tauschen über dem Limit bleibt zu.
     */
    const slots = werft.perkSlots(ship.model);
    const schrumpft = Array.isArray(perks) && perks.length < ship.perks.length;
    const limit = schrumpft ? Math.max(slots, perks.length) : slots;
    if (!validatePerkSet(ship.model, perks, limit)) {
      return reply.code(400).send({ error: 'Ungültige Perk-Auswahl.' });
    }

    // Besitz-Pflicht wie beim Ausrüsten: nur was im Inventar liegt, darf an
    // Bord — das Item bleibt dabei im Inventar (Panzerungs-Analogie).
    const items = await inventory.items(account.id);
    for (const perkId of perks) {
      if (!items.some((eintrag) => eintrag.itemId === perkId && eintrag.quantity > 0)) {
        return reply.code(409).send({ error: 'Perk nicht im Inventar.' });
      }
    }

    await werft.setPerks(account.id, shipId, perks);
    return mutationResponse(account.id);
  });

  /*
   * Schadensmeldung des Spielservers am Rundenende (Versenkung/EXIT = 0,
   * Extraktion = Rest-HP). Der interne Schlüssel ist die ganze Absicherung —
   * ein Client könnte sein Schiff sonst selbst heilen. KEIN automatischer
   * Reparaturstart: das entscheidet der Spieler in der Werft.
   */
  app.post('/internal/ship-damage', async (request, reply) => {
    if (request.headers['x-internal-key'] !== env.internalKey) {
      return reply.code(403).send({ error: 'Kein Zugriff.' });
    }
    const body = (request.body ?? {}) as Partial<{
      accountId: string;
      shipId: string;
      hp: number;
    }>;
    if (
      typeof body.accountId !== 'string' ||
      typeof body.shipId !== 'string' ||
      typeof body.hp !== 'number' ||
      !Number.isFinite(body.hp)
    ) {
      return reply.code(400).send({ error: 'accountId, shipId und hp erwartet.' });
    }
    const ok = await werft.applyDamage(body.accountId, body.shipId, body.hp);
    if (!ok) {
      console.warn(
        `[api] Schadensmeldung verworfen — Schiff ${body.shipId} gehört nicht zu ${body.accountId}.`,
      );
    }
    return { ok };
  });
}
