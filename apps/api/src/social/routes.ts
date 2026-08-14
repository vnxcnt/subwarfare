import type {
  FriendEntry,
  FriendsPayload,
  FriendshipState,
  PlayerProfile,
  StoredChatMessage,
} from '@subwarfare/shared';
import { CHAT_HISTORY_LIMIT, progressionFromXp } from '@subwarfare/shared';
import type { FastifyInstance } from 'fastify';
import type { Account, AccountStore } from '../accounts/store.js';
import { accountFromRequest } from '../auth/routes.js';
import type { FleetStore } from '../fleet/store.js';
import { dmKey, type SocialStore } from './store.js';

/**
 * Anbindung an den Lobby-Socket — die Routen kennen kein socket.io. `online`
 * fragt, ob ein Konto gerade verbunden ist (Freundesliste), `notify` stößt
 * bei der Gegenseite ein `social:update` an, damit ihre Liste live nachzieht.
 */
export interface SocialHooks {
  online(accountId: string): boolean;
  notify(accountId: string): void;
}

export function registerSocialRoutes(
  app: FastifyInstance,
  accounts: AccountStore,
  fleets: FleetStore,
  social: SocialStore,
  hooks: SocialHooks,
): void {
  /** Konto-IDs zu Anzeige-Einträgen auflösen; gelöschte Konten fallen raus. */
  async function hydrate(ids: string[]): Promise<FriendEntry[]> {
    const eintraege: FriendEntry[] = [];
    for (const id of ids) {
      const konto = await accounts.byId(id);
      if (!konto) continue;
      eintraege.push({
        accountId: konto.id,
        displayName: konto.displayName,
        avatarUrl: konto.avatarUrl,
        level: progressionFromXp(konto.xp).level,
        online: hooks.online(konto.id),
      });
    }
    // Online zuerst, dann alphabetisch — die Liste soll Gesprächspartner
    // anbieten, nicht das Archiv sortieren.
    return eintraege.sort(
      (a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName),
    );
  }

  async function payloadFor(accountId: string): Promise<FriendsPayload> {
    const sets = await social.sets(accountId);
    const [friends, incoming, outgoing] = await Promise.all([
      hydrate(sets.friends),
      hydrate(sets.incoming),
      hydrate(sets.outgoing),
    ]);
    return { friends, incoming, outgoing };
  }

  /** Ziel-Konto aus dem Body — null, wenn es fehlt oder nicht existiert. */
  async function targetFrom(body: unknown): Promise<Account | null> {
    const { accountId } = (body ?? {}) as Partial<{ accountId: string }>;
    if (typeof accountId !== 'string' || accountId.length === 0) return null;
    return accounts.byId(accountId);
  }

  app.get('/social/friends', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    return payloadFor(account.id);
  });

  app.post('/social/friends/request', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    const target = await targetFrom(request.body);
    if (!target) return reply.code(404).send({ error: 'Spieler nicht gefunden.' });
    if (target.id === account.id) {
      return reply.code(400).send({ error: 'Mit sich selbst ist man immer befreundet.' });
    }
    await social.request(account.id, target.id);
    hooks.notify(target.id);
    return payloadFor(account.id);
  });

  app.post('/social/friends/accept', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    const target = await targetFrom(request.body);
    if (!target) return reply.code(404).send({ error: 'Spieler nicht gefunden.' });
    const result = await social.accept(account.id, target.id);
    if (result === 'not_found') {
      return reply.code(404).send({ error: 'Keine offene Anfrage dieses Spielers.' });
    }
    hooks.notify(target.id);
    return payloadFor(account.id);
  });

  app.post('/social/friends/decline', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    const target = await targetFrom(request.body);
    if (!target) return reply.code(404).send({ error: 'Spieler nicht gefunden.' });
    await social.decline(account.id, target.id);
    hooks.notify(target.id);
    return payloadFor(account.id);
  });

  app.post('/social/friends/cancel', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    const target = await targetFrom(request.body);
    if (!target) return reply.code(404).send({ error: 'Spieler nicht gefunden.' });
    await social.cancel(account.id, target.id);
    hooks.notify(target.id);
    return payloadFor(account.id);
  });

  app.post('/social/friends/remove', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    const target = await targetFrom(request.body);
    if (!target) return reply.code(404).send({ error: 'Spieler nicht gefunden.' });
    await social.remove(account.id, target.id);
    hooks.notify(target.id);
    return payloadFor(account.id);
  });

  /*
   * Öffentliches Profil — was jeder Angemeldete über einen Spieler sehen
   * darf: Name, Bild, Fortschritt, PvP-Bilanz, Flottille samt Rang. Bewusst
   * OHNE Coins, Mail oder Verknüpfungen — das gehört dem Konto allein.
   */
  app.get('/social/profile/:accountId', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    const { accountId } = request.params as { accountId: string };
    const target = await accounts.byId(accountId);
    if (!target) return reply.code(404).send({ error: 'Spieler nicht gefunden.' });

    let fleet: PlayerProfile['fleet'] = null;
    const membership = await fleets.membership(target.id);
    if (membership) {
      const mine = await fleets.mine(target.id);
      if (mine) fleet = { name: mine.fleet.name, rank: membership.rank };
    }

    let friendship: FriendshipState = 'none';
    if (target.id === account.id) {
      friendship = 'self';
    } else {
      const sets = await social.sets(account.id);
      if (sets.friends.includes(target.id)) friendship = 'friends';
      else if (sets.incoming.includes(target.id)) friendship = 'incoming';
      else if (sets.outgoing.includes(target.id)) friendship = 'outgoing';
    }

    const profile: PlayerProfile = {
      accountId: target.id,
      displayName: target.displayName,
      avatarUrl: target.avatarUrl,
      level: progressionFromXp(target.xp).level,
      xp: target.xp,
      kills: target.kills,
      deaths: target.deaths,
      createdAt: target.createdAt,
      fleet,
      friendship,
    };
    return profile;
  });

  /*
   * Verlauf der gespeicherten Kanäle. Die Zugangsregeln sind dieselben wie
   * beim Senden: Flottille nur für Mitglieder, Privat nur unter Freunden —
   * sonst wäre die Historie ein Schlupfloch am Sende-Gate vorbei.
   */
  app.get('/social/messages', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    const { channel, with: withId } = (request.query ?? {}) as Partial<{
      channel: string;
      with: string;
    }>;

    let contextId: string;
    if (channel === 'flottille') {
      const membership = await fleets.membership(account.id);
      if (!membership) return reply.code(403).send({ error: 'Du gehörst keiner Flottille an.' });
      contextId = membership.fleetId;
    } else if (channel === 'privat') {
      if (typeof withId !== 'string' || withId.length === 0) {
        return reply.code(400).send({ error: 'Gesprächspartner fehlt.' });
      }
      if (!(await social.areFriends(account.id, withId))) {
        return reply.code(403).send({ error: 'Private Gespräche gibt es nur unter Freunden.' });
      }
      contextId = dmKey(account.id, withId);
    } else {
      return reply.code(400).send({ error: 'Unbekannter Kanal.' });
    }

    const rows = await social.messages(
      channel,
      contextId,
      CHAT_HISTORY_LIMIT,
    );
    // Absender-Namen und -Level beim LESEN auflösen, nie speichern — so
    // zeigen alte Zeilen immer den aktuellen Namen. Gelöschte Konten sind
    // durch CASCADE ohnehin samt Zeilen weg.
    const messages: StoredChatMessage[] = [];
    for (const row of rows) {
      const sender = await accounts.byId(row.senderId);
      messages.push({
        id: row.id,
        senderId: row.senderId,
        name: sender?.displayName ?? 'Unbekannt',
        text: row.text,
        level: progressionFromXp(sender?.xp ?? 0).level,
        role: sender?.role ?? 0,
        at: row.at,
      });
    }
    return { messages };
  });
}
