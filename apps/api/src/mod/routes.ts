import type {
  ModAccountDetail,
  ModAccountSummary,
  ModItemRequest,
} from '@subwarfare/shared';
import {
  DEFAULT_SHIP_STATS,
  FLEET_RANK_LEADER,
  ROLE_DEVELOPER,
  ROLE_GAMEMASTER,
  ROLE_MODERATOR,
  equipSlotsForArmament,
  isItemId,
  isPlayableModel,
  itemById,
  progressionFromXp,
} from '@subwarfare/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import type { Account, AccountStore } from '../accounts/store.js';
import { accountFromRequest } from '../auth/routes.js';
import { getPool } from '../db/pool.js';
import type { InventoryStore } from '../economy/store.js';
import { env } from '../env.js';
import type { FleetStore } from '../fleet/store.js';
import type { SocialStore } from '../social/store.js';
import type { WerftService } from '../werft/service.js';

/** Obergrenze fürs Bestand-Setzen — schützt vor Tippfehler-Millionen. */
const MOD_QUANTITY_MAX = 9999;

/** Obergrenzen für Konto-Werte — großzügig, aber tippfehlerfest. */
const MOD_COINS_MAX = 99_999_999;
const MOD_XP_MAX = 99_999_999;

/** Anbindung an den Lobby-Socket für den Chat-Purge-Broadcast. */
export interface ModHooks {
  purgeChat(accountId: string): void;
}

/**
 * Editierbare Katalog-Tabellen des Entwickler-DB-Editors: je Tabelle der
 * Primärschlüssel und die freigegebenen Zahlen-Spalten samt Wertebereich.
 * Struktur-Spalten (armament, weapon) bleiben bewusst außen vor — sie sind
 * Verträge mit dem Code-Katalog, keine Stellschrauben.
 */
const DB_TABLES: Record<
  string,
  { pk: string; columns: Record<string, { min: number; max: number; ganzzahl?: boolean }> }
> = {
  ships: {
    pk: 'model',
    columns: {
      hp: { min: 1, max: 100_000, ganzzahl: true },
      speed: { min: 0.05, max: 10 },
      price: { min: 0, max: 1_000_000, ganzzahl: true },
      perk_slots: { min: 0, max: 10, ganzzahl: true },
      size: { min: 0.2, max: 5 },
    },
  },
  armor: {
    pk: 'item_id',
    columns: { level: { min: 1, max: 99, ganzzahl: true }, absorb: { min: 0, max: 0.95 } },
  },
  weapon_items: {
    pk: 'item_id',
    columns: { damage: { min: 1, max: 50_000, ganzzahl: true } },
  },
};

/**
 * Moderations-Routen. Drei Stufen: Moderator (Rolle 1) für Chat-Werkzeuge,
 * Gamemaster (2) zusätzlich für Konten (Bann, Löschung, Coins, XP, Rolle
 * Moderator), Entwickler (3) für alle Rollen und den DB-Editor. Die Rolle
 * kommt bei JEDER Anfrage FRISCH aus dem Konto (nie aus dem Token) — ein
 * Entzug wirkt sofort. Jede Mutation landet im Server-Log.
 */
export function registerModRoutes(
  app: FastifyInstance,
  accounts: AccountStore,
  inventory: InventoryStore,
  fleets: FleetStore,
  werft: WerftService,
  social: SocialStore,
  hooks: ModHooks,
): void {
  /** Angemeldetes Konto mit mindestens `minRole` — sonst null. */
  async function berechtigt(request: FastifyRequest, minRole: number): Promise<Account | null> {
    const account = await accountFromRequest(request, accounts);
    if (!account || account.role < minRole) return null;
    return account;
  }

  /** Kurzform für die bestehenden GM-Werkzeuge. */
  function moderator(request: FastifyRequest): Promise<Account | null> {
    return berechtigt(request, ROLE_GAMEMASTER);
  }

  /**
   * Darf `actor` das Konto `target` verändern? Nie sich selbst; sonst nur
   * nach UNTEN — Entwickler dürfen zusätzlich andere Entwickler anfassen
   * (kleines Team, jemand muss es können).
   */
  function darfBearbeiten(actor: Account, target: Account): boolean {
    if (actor.id === target.id) return false;
    return actor.role > target.role || actor.role === ROLE_DEVELOPER;
  }

  /** Ziel-Konto aus dem Body samt Hierarchie-Prüfung; antwortet selbst. */
  async function zielFuerMutation(
    actor: Account,
    body: unknown,
  ): Promise<{ ziel: Account } | { fehler: { code: number; error: string } }> {
    const { accountId } = (body ?? {}) as Partial<{ accountId: string }>;
    if (typeof accountId !== 'string' || accountId.length === 0) {
      return { fehler: { code: 400, error: 'Konto fehlt.' } };
    }
    const ziel = await accounts.byId(accountId);
    if (!ziel) return { fehler: { code: 404, error: 'Konto nicht gefunden.' } };
    if (!darfBearbeiten(actor, ziel)) {
      return { fehler: { code: 403, error: 'Keine Berechtigung für dieses Konto.' } };
    }
    return { ziel };
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

    const [items, ships, loadouts, membership] = await Promise.all([
      inventory.items(konto.id),
      werft.list(konto.id),
      inventory.loadouts(konto.id),
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
      bannedReason: konto.bannedReason,
      chatMuted: konto.chatMuted,
      items,
      loadouts,
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

  /* ---- Konto-Werte (Gamemaster + Entwickler) ---------------------------- */

  /*
   * Rollen-Matrix: Entwickler vergeben ALLE Rollen (0..3), Gamemaster nur
   * Spieler/Moderator (0..1). Nie an sich selbst, nie nach oben (außer
   * Entwickler untereinander, siehe darfBearbeiten).
   */
  app.post('/mod/role', async (request, reply) => {
    const mod = await moderator(request);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const { role } = (request.body ?? {}) as Partial<{ role: number }>;
    const erlaubt = mod.role === ROLE_DEVELOPER ? [0, 1, 2, 3] : [0, ROLE_MODERATOR];
    if (typeof role !== 'number' || !erlaubt.includes(role)) {
      return reply.code(400).send({ error: 'Diese Rolle darfst du nicht vergeben.' });
    }
    const ergebnis = await zielFuerMutation(mod, request.body);
    if ('fehler' in ergebnis) {
      return reply.code(ergebnis.fehler.code).send({ error: ergebnis.fehler.error });
    }
    await accounts.setRole(ergebnis.ziel.id, role);
    console.log(
      `[mod] ${mod.displayName} (${mod.id}) setzt Rolle ${ergebnis.ziel.role} → ${role} bei ${ergebnis.ziel.displayName} (${ergebnis.ziel.id}).`,
    );
    return { ok: true };
  });

  app.post('/mod/coins', async (request, reply) => {
    const mod = await moderator(request);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const { coins } = (request.body ?? {}) as Partial<{ coins: number }>;
    if (typeof coins !== 'number' || !Number.isInteger(coins) || coins < 0 || coins > MOD_COINS_MAX) {
      return reply.code(400).send({ error: `Coins: 0 bis ${MOD_COINS_MAX}.` });
    }
    const ergebnis = await zielFuerMutation(mod, request.body);
    if ('fehler' in ergebnis) {
      return reply.code(ergebnis.fehler.code).send({ error: ergebnis.fehler.error });
    }
    await accounts.setCoins(ergebnis.ziel.id, coins);
    console.log(
      `[mod] ${mod.displayName} (${mod.id}) setzt Coins ${ergebnis.ziel.coins} → ${coins} bei ${ergebnis.ziel.displayName} (${ergebnis.ziel.id}).`,
    );
    return { ok: true };
  });

  app.post('/mod/xp', async (request, reply) => {
    const mod = await moderator(request);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const { xp } = (request.body ?? {}) as Partial<{ xp: number }>;
    if (typeof xp !== 'number' || !Number.isInteger(xp) || xp < 0 || xp > MOD_XP_MAX) {
      return reply.code(400).send({ error: `XP: 0 bis ${MOD_XP_MAX}.` });
    }
    const ergebnis = await zielFuerMutation(mod, request.body);
    if ('fehler' in ergebnis) {
      return reply.code(ergebnis.fehler.code).send({ error: ergebnis.fehler.error });
    }
    await accounts.setXp(ergebnis.ziel.id, xp);
    console.log(
      `[mod] ${mod.displayName} (${mod.id}) setzt XP ${ergebnis.ziel.xp} → ${xp} bei ${ergebnis.ziel.displayName} (${ergebnis.ziel.id}).`,
    );
    return { ok: true };
  });

  /*
   * Kontosperre (BAN): mit Begründung. Ein gesperrtes Konto fällt an jedem
   * Auth-Punkt durch (REST, Lobby, Login) — das umlaufende Token ist damit
   * sofort wertlos.
   */
  app.post('/mod/ban', async (request, reply) => {
    const mod = await moderator(request);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const { reason } = (request.body ?? {}) as Partial<{ reason: string }>;
    const grund = typeof reason === 'string' ? reason.replace(/\p{C}/gu, '').trim().slice(0, 200) : '';
    if (grund.length < 3) {
      return reply.code(400).send({ error: 'Begründung: mindestens 3 Zeichen.' });
    }
    const ergebnis = await zielFuerMutation(mod, request.body);
    if ('fehler' in ergebnis) {
      return reply.code(ergebnis.fehler.code).send({ error: ergebnis.fehler.error });
    }
    await accounts.setBan(ergebnis.ziel.id, grund);
    console.log(
      `[mod] ${mod.displayName} (${mod.id}) SPERRT ${ergebnis.ziel.displayName} (${ergebnis.ziel.id}): ${grund}`,
    );
    return { ok: true };
  });

  app.post('/mod/unban', async (request, reply) => {
    const mod = await moderator(request);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const ergebnis = await zielFuerMutation(mod, request.body);
    if ('fehler' in ergebnis) {
      return reply.code(ergebnis.fehler.code).send({ error: ergebnis.fehler.error });
    }
    await accounts.setBan(ergebnis.ziel.id, null);
    console.log(
      `[mod] ${mod.displayName} (${mod.id}) entsperrt ${ergebnis.ziel.displayName} (${ergebnis.ziel.id}).`,
    );
    return { ok: true };
  });

  /** Konto-Löschung durch die Moderation — endgültig, wie die Selbstlöschung. */
  app.post('/mod/delete', async (request, reply) => {
    const mod = await moderator(request);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const ergebnis = await zielFuerMutation(mod, request.body);
    if ('fehler' in ergebnis) {
      return reply.code(ergebnis.fehler.code).send({ error: ergebnis.fehler.error });
    }
    const ziel = ergebnis.ziel;
    await accounts.deleteAccount(ziel.id);
    // Memory-Betrieb: Besitz, Flotte und Chat miträumen (MariaDB: CASCADE).
    await inventory.purge(ziel.id);
    await werft.purge(ziel.id);
    await social.deleteBySender(ziel.id);
    console.log(
      `[mod] ${mod.displayName} (${mod.id}) LÖSCHT Konto ${ziel.displayName} (${ziel.id}).`,
    );
    return { ok: true };
  });

  /* ---- Chat-Werkzeuge (auch Moderatoren, Rolle 1) ----------------------- */

  /** Alle Nachrichten eines Kontos löschen — gespeicherte UND live sichtbare. */
  app.post('/mod/chat/purge', async (request, reply) => {
    const mod = await berechtigt(request, ROLE_MODERATOR);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const ergebnis = await zielFuerMutation(mod, request.body);
    if ('fehler' in ergebnis) {
      return reply.code(ergebnis.fehler.code).send({ error: ergebnis.fehler.error });
    }
    await social.deleteBySender(ergebnis.ziel.id);
    hooks.purgeChat(ergebnis.ziel.id);
    console.log(
      `[mod] ${mod.displayName} (${mod.id}) löscht die Chatnachrichten von ${ergebnis.ziel.displayName} (${ergebnis.ziel.id}).`,
    );
    return { ok: true };
  });

  /** Chatsperre setzen/aufheben — das Konto bleibt sonst voll nutzbar. */
  app.post('/mod/chat/mute', async (request, reply) => {
    const mod = await berechtigt(request, ROLE_MODERATOR);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const { muted } = (request.body ?? {}) as Partial<{ muted: boolean }>;
    if (typeof muted !== 'boolean') return reply.code(400).send({ error: 'muted erwartet.' });
    const ergebnis = await zielFuerMutation(mod, request.body);
    if ('fehler' in ergebnis) {
      return reply.code(ergebnis.fehler.code).send({ error: ergebnis.fehler.error });
    }
    await accounts.setChatMuted(ergebnis.ziel.id, muted);
    console.log(
      `[mod] ${mod.displayName} (${mod.id}) ${muted ? 'verhängt' : 'hebt'} Chatsperre für ${ergebnis.ziel.displayName} (${ergebnis.ziel.id})${muted ? '' : ' auf'}.`,
    );
    return { ok: true, muted };
  });

  /* ---- Entwickler: Ausrüstungs-Korrektur + DB-Editor -------------------- */

  /** ship_loadouts eines Kontos korrigieren (Slot setzen oder leeren). */
  app.post('/mod/loadout', async (request, reply) => {
    const mod = await berechtigt(request, ROLE_DEVELOPER);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const { accountId, model, slot, itemId, count } = (request.body ?? {}) as Partial<{
      accountId: string;
      model: string;
      slot: string;
      itemId: string | null;
      count: number | null;
    }>;
    if (typeof accountId !== 'string' || !(await accounts.byId(accountId))) {
      return reply.code(404).send({ error: 'Konto nicht gefunden.' });
    }
    if (!isPlayableModel(model)) return reply.code(400).send({ error: 'Unbekanntes Schiff.' });
    const slots = equipSlotsForArmament(DEFAULT_SHIP_STATS[model].armament);
    if (typeof slot !== 'string' || !(slots as string[]).includes(slot)) {
      return reply.code(400).send({ error: 'Dieses Schiff hat keinen solchen Slot.' });
    }
    const kategorie = slot as (typeof slots)[number];
    if (itemId === null || itemId === undefined) {
      await inventory.setLoadout(accountId, model, kategorie, null);
    } else {
      if (!isItemId(itemId) || itemById(itemId).category !== kategorie) {
        return reply.code(400).send({ error: 'Item passt nicht in diesen Slot.' });
      }
      const menge =
        typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= 999
          ? count
          : null;
      await inventory.setLoadout(accountId, model, kategorie, itemId, menge);
    }
    console.log(
      `[mod] ${mod.displayName} (${mod.id}) setzt Loadout ${model}/${slot} = ${itemId ?? 'leer'} bei ${accountId}.`,
    );
    return { loadouts: await inventory.loadouts(accountId) };
  });

  /*
   * DB-Editor: Katalog-Tabellen (ships, armor, weapon_items) lesen und
   * Zahlen-Spalten setzen. NUR mit Datenbank — der Memory-Betrieb kennt die
   * Tabellen nicht. Änderungen greifen erst mit dem nächsten Dienst-Neustart
   * (api und game-server laden die Kataloge beim Start).
   */
  app.get('/mod/db/:table', async (request, reply) => {
    const mod = await berechtigt(request, ROLE_DEVELOPER);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const { table } = request.params as { table: string };
    const schema = DB_TABLES[table];
    if (!schema) return reply.code(400).send({ error: 'Unbekannte Tabelle.' });
    if (!env.databaseUrl) {
      return reply.code(409).send({ error: 'Ohne Datenbank (Memory-Betrieb) nicht verfügbar.' });
    }
    // Tabellen- und Spaltennamen kommen aus der Whitelist oben, nie aus der
    // Anfrage — deshalb dürfen sie in den SQL-Text.
    const [rows] = await getPool().query<RowDataPacket[]>(`SELECT * FROM ${table}`);
    return { table, pk: schema.pk, editable: Object.keys(schema.columns), rows };
  });

  app.post('/mod/db/:table', async (request, reply) => {
    const mod = await berechtigt(request, ROLE_DEVELOPER);
    if (!mod) return reply.code(403).send({ error: 'Kein Zugriff.' });
    const { table } = request.params as { table: string };
    const schema = DB_TABLES[table];
    if (!schema) return reply.code(400).send({ error: 'Unbekannte Tabelle.' });
    if (!env.databaseUrl) {
      return reply.code(409).send({ error: 'Ohne Datenbank (Memory-Betrieb) nicht verfügbar.' });
    }
    const { key, column, value } = (request.body ?? {}) as Partial<{
      key: string;
      column: string;
      value: number;
    }>;
    const grenzen = column !== undefined ? schema.columns[column] : undefined;
    if (typeof key !== 'string' || key.length === 0 || !grenzen) {
      return reply.code(400).send({ error: 'Diese Spalte ist nicht editierbar.' });
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < grenzen.min || value > grenzen.max) {
      return reply.code(400).send({ error: `Wert: ${grenzen.min} bis ${grenzen.max}.` });
    }
    // Integer-Spalten (INT/TINYINT) verlangen ganze Zahlen — MariaDB würde
    // Bruchwerte sonst STILL runden und die Anzeige löge gegenüber der DB.
    if (grenzen.ganzzahl && !Number.isInteger(value)) {
      return reply.code(400).send({ error: 'Wert: eine ganze Zahl.' });
    }
    await getPool().execute(`UPDATE ${table} SET ${column} = ? WHERE ${schema.pk} = ?`, [
      value,
      key,
    ]);
    console.log(`[mod] ${mod.displayName} (${mod.id}) setzt ${table}.${column} = ${value} für ${key}.`);
    return { ok: true, hint: 'Greift nach dem nächsten Neustart der Dienste.' };
  });
}
