import type { AuthResponse } from '@subwarfare/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AccountStore } from '../accounts/store.js';
import type { InventoryStore } from '../economy/store.js';
import { sanitizeDisplayName, toProfile } from '../accounts/store.js';
import { env } from '../env.js';
import { discordAuthorizeUrl, discordEnabled, redeemDiscordCode } from './discord.js';
import { googleEnabled, verifyGoogleCredential } from './google.js';
import {
  signLinkTicket,
  signOauthState,
  signSession,
  verifyLinkTicket,
  verifyOauthState,
  verifySession,
} from './jwt.js';

/**
 * Liest das Sitzungs-Token aus dem `Authorization`-Kopf.
 *
 * Bewusst kein Cookie: Client und Backend laufen lokal auf verschiedenen
 * Ports, und ein Token im Kopf ist gegen CSRF unempfindlich — es wird nie
 * automatisch mitgeschickt.
 */
export async function accountFromRequest(
  request: FastifyRequest,
  accounts: AccountStore,
): Promise<Awaited<ReturnType<AccountStore['byId']>>> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const claims = await verifySession(header.slice(7));
  if (!claims) return null;
  const account = await accounts.byId(claims.sub);
  // Gesperrte Konten fallen an JEDEM Auth-Punkt durch: das umlaufende Token
  // wird damit wertlos, der Client landet über die 401er am Login.
  if (account?.bannedReason !== null && account?.bannedReason !== undefined) return null;
  return account;
}

/**
 * Entwickler-Konten hängen am blossen Anzeigenamen (`dev_accounts`) — wer den
 * Namen kennt, kommt per `/auth/dev` hinein. Eine echte Identität daran zu
 * hängen würde diese Hintertür an ein Konto mit realem Login binden.
 */
const DEV_LINK_REFUSAL = 'Entwickler-Konten können nicht verknüpft werden.';

export function registerAuthRoutes(
  app: FastifyInstance,
  accounts: AccountStore,
  inventory: InventoryStore,
): void {
  /** Welche Anmeldewege dieser Server anbietet — der Client richtet sich danach. */
  app.get('/auth/methods', async () => ({
    google: googleEnabled(),
    discord: discordEnabled(),
    dev: env.authDev,
  }));

  /**
   * Startet den Discord-Login: signierter state, Sprung zu Discord.
   *
   * `n` ist die Wiedererkennung des Browsers (der Client erzeugt sie und legt
   * sie in `sessionStorage`). Sie läuft signiert durch den State und kommt im
   * Rücklauf zurück — ohne sie könnte ein Angreifer ein vorbereitetes
   * code/state-Paar unterschieben und das Opfer in SEIN Konto einloggen.
   */
  app.get('/auth/discord', async (request, reply) => {
    if (!discordEnabled()) {
      return reply.code(503).send({ error: 'Discord-Anmeldung ist auf diesem Server nicht aktiv.' });
    }
    const query = request.query as { n?: unknown } | undefined;
    const nonce = typeof query?.n === 'string' ? query.n.slice(0, 64) : undefined;
    return reply.redirect(discordAuthorizeUrl(await signOauthState({ nonce })), 302);
  });

  /**
   * Rücklauf von Discord.
   *
   * Endet immer in einer Umleitung zur Client-App: Erfolg trägt das
   * Sitzungs-Token im URL-FRAGMENT (`#token=…`) — das Fragment verlässt den
   * Browser nie, taucht also weder in Server-Logs noch im Referrer auf.
   * Fehler landen als `#error=…` am Login-Bildschirm statt als nackte
   * JSON-Antwort in einem sonst leeren Tab.
   */
  app.get('/auth/discord/callback', async (request, reply) => {
    const back = (fragment: string) => reply.redirect(`${env.clientUrl}/login#${fragment}`, 302);

    if (!discordEnabled()) return back('error=' + encodeURIComponent('Discord-Anmeldung ist nicht aktiv.'));

    const query = request.query as { code?: unknown; state?: unknown } | undefined;
    const state = await verifyOauthState(query?.state);
    if (!state.valid) {
      return back('error=' + encodeURIComponent('Anmeldung abgelaufen — bitte erneut versuchen.'));
    }
    if (typeof query?.code !== 'string' || query.code.length === 0) {
      return back('error=' + encodeURIComponent('Discord hat die Anmeldung abgebrochen.'));
    }

    const identity = await redeemDiscordCode(query.code);
    if (!identity) {
      return back('error=' + encodeURIComponent('Discord-Anmeldung fehlgeschlagen.'));
    }

    // VERKNÜPFUNG statt Login: hier wird NICHT verknüpft, sondern nur ein
    // kurzlebiger Beleg über die geprüfte Identität ausgestellt. Einlösen kann
    // ihn allein der Browser, der die Sitzung dieses Kontos hält — sonst könnte
    // ein Angreifer seinen eigenen Verknüpfungs-State unterschieben und fremde
    // Discord-Konten an sein eigenes Spieler-Konto binden.
    if (state.linkAccountId) {
      const ticket = await signLinkTicket({
        sub: state.linkAccountId,
        provider: 'discord',
        externalId: identity.discordId,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
      });
      return reply.redirect(`${env.clientUrl}/menu#linkticket=${encodeURIComponent(ticket)}`, 302);
    }

    const account = await accounts.upsertDiscord(identity);
    await accounts.touchLogin(account.id);
    const token = await signSession({ sub: account.id, name: account.displayName });
    // Die Nonce des startenden Browsers läuft zurück; der Client übernimmt das
    // Token nur, wenn sie zu seiner gespeicherten passt.
    const nonce = state.nonce ? `&n=${encodeURIComponent(state.nonce)}` : '';
    return back(`token=${encodeURIComponent(token)}${nonce}`);
  });

  /**
   * Startet die Discord-VERKNÜPFUNG aus den Einstellungen. Liefert die
   * Sprungadresse als JSON statt selbst umzuleiten: der Aufruf kommt als
   * fetch mit Authorization-Kopf — das Sitzungs-Token gehört nie in eine URL,
   * und die Konto-ID wandert signiert in den OAuth-State.
   */
  app.post('/account/link/discord/start', async (request, reply) => {
    if (!discordEnabled()) {
      return reply.code(503).send({ error: 'Discord-Anmeldung ist auf diesem Server nicht aktiv.' });
    }
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    if (account.isDev) return reply.code(409).send({ error: DEV_LINK_REFUSAL });
    if (account.discordId) {
      return reply.code(409).send({ error: 'Discord ist bereits verknüpft.' });
    }
    return { url: discordAuthorizeUrl(await signOauthState({ linkAccountId: account.id })) };
  });

  /**
   * Löst den Verknüpfungs-Beleg aus dem OAuth-Rücklauf ein.
   *
   * Der Beleg allein reicht NICHT: er muss auf dasselbe Konto lauten wie die
   * Sitzung, mit der er eingereicht wird. Genau daran scheitert ein
   * untergeschobener Beleg für ein fremdes Konto.
   */
  app.post('/account/link/discord/confirm', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    if (account.isDev) return reply.code(409).send({ error: DEV_LINK_REFUSAL });

    const body = request.body as { ticket?: unknown } | undefined;
    const claims = await verifyLinkTicket(body?.ticket);
    if (!claims) {
      return reply.code(400).send({ error: 'Verknüpfung abgelaufen — bitte erneut versuchen.' });
    }
    if (claims.sub !== account.id) {
      console.warn(
        `[api] Verknüpfungs-Beleg für ${claims.sub} in Sitzung von ${account.id} eingereicht — abgelehnt.`,
      );
      return reply.code(403).send({ error: 'Diese Verknüpfung gehört zu einem anderen Konto.' });
    }

    const result = await accounts.linkDiscord(account.id, {
      discordId: claims.externalId,
      displayName: claims.displayName,
      avatarUrl: claims.avatarUrl,
    });
    if (result === 'taken') {
      return reply
        .code(409)
        .send({ error: 'Dieses Discord-Konto ist bereits mit einem anderen Spieler-Konto verknüpft.' });
    }
    if (result === 'conflict') {
      return reply.code(409).send({ error: 'Dieses Konto trägt bereits eine Discord-Verknüpfung.' });
    }
    const fresh = await accounts.byId(account.id);
    if (!fresh) return reply.code(500).send({ error: 'Konto nicht lesbar.' });
    return toProfile(fresh);
  });

  /**
   * Google-VERKNÜPFUNG: dasselbe ID-Token wie beim Login, nur wird die
   * Identität an das ANGEMELDETE Konto gehängt statt eines zu suchen.
   * Antwort ist das frische Profil (hasGoogle aktualisiert sich sofort).
   */
  app.post('/account/link/google', async (request, reply) => {
    if (!googleEnabled()) {
      return reply.code(503).send({ error: 'Google-Anmeldung ist auf diesem Server nicht aktiv.' });
    }
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    if (account.isDev) return reply.code(409).send({ error: DEV_LINK_REFUSAL });

    const body = request.body as { credential?: unknown } | undefined;
    const identity = await verifyGoogleCredential(body?.credential);
    if (!identity) return reply.code(401).send({ error: 'Google-Token ungültig.' });

    const result = await accounts.linkGoogle(account.id, identity);
    if (result === 'taken') {
      return reply
        .code(409)
        .send({ error: 'Dieses Google-Konto ist bereits mit einem anderen Spieler-Konto verknüpft.' });
    }
    if (result === 'conflict') {
      return reply.code(409).send({ error: 'Dieses Konto trägt bereits eine Google-Verknüpfung.' });
    }
    const fresh = await accounts.byId(account.id);
    if (!fresh) return reply.code(500).send({ error: 'Konto nicht lesbar.' });
    return toProfile(fresh);
  });

  app.post('/auth/google', async (request, reply) => {
    if (!googleEnabled()) {
      return reply.code(503).send({ error: 'Google-Anmeldung ist auf diesem Server nicht aktiv.' });
    }

    const body = request.body as { credential?: unknown } | undefined;
    const identity = await verifyGoogleCredential(body?.credential);
    if (!identity) return reply.code(401).send({ error: 'Google-Token ungültig.' });

    const account = await accounts.upsertGoogle(identity);
    const response: AuthResponse = {
      token: await signSession({ sub: account.id, name: account.displayName }),
      account: toProfile(account),
    };
    return response;
  });

  app.post('/auth/dev', async (request, reply) => {
    if (!env.authDev) {
      return reply.code(403).send({ error: 'Entwickler-Anmeldung ist abgeschaltet.' });
    }

    const body = request.body as { name?: unknown } | undefined;
    const name = sanitizeDisplayName(body?.name);
    if (!name) return reply.code(400).send({ error: 'Name muss 2 bis 24 Zeichen haben.' });

    const account = await accounts.upsertDev(name);
    if (account.bannedReason !== null) {
      return reply.code(403).send({ error: `Konto gesperrt: ${account.bannedReason}` });
    }
    await accounts.touchLogin(account.id);
    const response: AuthResponse = {
      token: await signSession({ sub: account.id, name: account.displayName }),
      account: toProfile(account),
    };
    return response;
  });

  app.get('/auth/me', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    return toProfile(account);
  });

  /**
   * Endgültige Konto-Löschung durch den Spieler selbst.
   *
   * Die Bestätigung ist Sache des Clients — hier zählt nur das gültige
   * Sitzungs-Token: wer es besitzt, IST der Kontoinhaber. Mitgelöscht wird
   * alles Abhängige (CASCADE); das noch umlaufende Sitzungs-Token wird damit
   * wertlos, weil jede Prüfung das Konto nicht mehr findet.
   */
  app.delete('/account', async (request, reply) => {
    const account = await accountFromRequest(request, accounts);
    if (!account) return reply.code(401).send({ error: 'Nicht angemeldet.' });
    await accounts.deleteAccount(account.id);
    // Besitz und Ausrüstung miträumen — in MariaDB ein No-op (CASCADE), im
    // Speicher-Betrieb hingegen Pflicht, sonst erbte ein neues Konto mit
    // zufällig gleicher ID nichts, aber die Maps wüchsen endlos.
    await inventory.purge(account.id);
    console.log(`[api] Konto ${account.id} (${account.displayName}) auf Wunsch gelöscht.`);
    return { ok: true };
  });
}
