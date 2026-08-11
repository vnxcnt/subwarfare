import type {
  InventoryPayload,
  LoadoutUpdateRequest,
  ShopBuyRequest,
  ShopBuyResponse,
} from '@subwarfare/shared';
import {
  DEFAULT_SHIP_STATS,
  equipSlotsForArmament,
  isItemId,
  isPlayableModel,
  itemById,
} from '@subwarfare/shared';
import type { FastifyInstance } from 'fastify';
import { accountFromRequest } from '../auth/routes.js';
import type { AccountStore } from '../accounts/store.js';
import type { InventoryStore } from './store.js';

/**
 * Inventar, Shop und Ausrüstung.
 *
 * Alle Preise und Regeln kommen aus dem Katalog in `@subwarfare/shared` — der
 * Client schickt nur Kennungen, nie Preise. Ein manipulierter Client kann
 * damit höchstens Dinge anfordern, die der Katalog sowieso erlaubt.
 */
export function registerEconomyRoutes(
  app: FastifyInstance,
  accounts: AccountStore,
  inventory: InventoryStore,
): void {
  app.get('/inventory', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });

    const payload: InventoryPayload = {
      items: await inventory.items(account.id),
      loadouts: await inventory.loadouts(account.id),
    };
    return payload;
  });

  app.post('/shop/buy', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });

    const { itemId } = (request.body ?? {}) as Partial<ShopBuyRequest>;
    if (!isItemId(itemId)) return reply.code(400).send({ error: 'Unbekanntes Item.' });

    const definition = itemById(itemId);
    if (definition.shopPrice === null) {
      return reply.code(400).send({ error: 'Dieses Item ist nicht käuflich.' });
    }

    const result = await inventory.purchase(account.id, itemId, definition.shopPrice);
    if (result === 'poor') {
      return reply.code(409).send({ error: 'Nicht genug Coins.' });
    }

    // Kontostand FRISCH lesen statt lokal rechnen — zwischen Abzug und Antwort
    // kann eine zweite Abbuchung gelaufen sein, und die Anzeige soll dem Konto
    // folgen, nicht einer Zwischenrechnung.
    const fresh = await accounts.byId(account.id);
    const payload: ShopBuyResponse = {
      coins: fresh?.coins ?? 0,
      items: await inventory.items(account.id),
    };
    return payload;
  });

  app.post('/loadout', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });

    const { model, slot, itemId } = (request.body ?? {}) as Partial<LoadoutUpdateRequest>;
    if (!isPlayableModel(model)) return reply.code(400).send({ error: 'Unbekanntes Schiff.' });

    // Die Slot-Liste folgt der Bewaffnung aus dem Code-Katalog: er ist der
    // Vertrag für die Ausrüstungs-STRUKTUR (die DB-Tabelle `ships` stimmt die
    // ZAHLEN ab, nicht die Slots).
    const slots = equipSlotsForArmament(DEFAULT_SHIP_STATS[model].armament);
    if (typeof slot !== 'string' || !(slots as string[]).includes(slot)) {
      return reply.code(400).send({ error: 'Dieses Schiff hat keinen solchen Slot.' });
    }
    const category = slot as (typeof slots)[number];

    if (itemId === null || itemId === undefined) {
      await inventory.setLoadout(account.id, model, category, null);
    } else {
      if (!isItemId(itemId)) return reply.code(400).send({ error: 'Unbekanntes Item.' });
      if (itemById(itemId).category !== category) {
        return reply.code(400).send({ error: 'Item passt nicht in diesen Slot.' });
      }
      // Nur Besitz darf equippt werden — sonst wären Shop und Coins Dekoration.
      const owned = await inventory.items(account.id);
      if (!owned.some((entry) => entry.itemId === itemId && entry.quantity > 0)) {
        return reply.code(409).send({ error: 'Item nicht im Inventar.' });
      }
      await inventory.setLoadout(account.id, model, category, itemId);
    }

    return { loadouts: await inventory.loadouts(account.id) };
  });
}
