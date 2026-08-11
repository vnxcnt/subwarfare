import type { AuthResponse } from '@subwarfare/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AccountStore } from '../accounts/store.js';
import type { InventoryStore } from '../economy/store.js';
import { sanitizeDisplayName, toProfile } from '../accounts/store.js';
import { env } from '../env.js';
import { discordAuthorizeUrl, discordEnabled, redeemDiscordCode } from './discord.js';
import { googleEnabled, verifyGoogleCredential } from './google.js';
import { signOauthState, signSession, verifyOauthState, verifySession } from './jwt.js';

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
  return accounts.byId(claims.sub);
}

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

  /** Startet den Discord-Login: signierter state, Sprung zu Discord. */
  app.get('/auth/discord', async (_request, reply) => {
    if (!discordEnabled()) {
      return reply.code(503).send({ error: 'Discord-Anmeldung ist auf diesem Server nicht aktiv.' });
    }
    return reply.redirect(discordAuthorizeUrl(await signOauthState()), 302);
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
    if (!(await verifyOauthState(query?.state))) {
      return back('error=' + encodeURIComponent('Anmeldung abgelaufen — bitte erneut versuchen.'));
    }
    if (typeof query?.code !== 'string' || query.code.length === 0) {
      return back('error=' + encodeURIComponent('Discord hat die Anmeldung abgebrochen.'));
    }

    const identity = await redeemDiscordCode(query.code);
    if (!identity) {
      return back('error=' + encodeURIComponent('Discord-Anmeldung fehlgeschlagen.'));
    }

    const account = await accounts.upsertDiscord(identity);
    await accounts.touchLogin(account.id);
    const token = await signSession({ sub: account.id, name: account.displayName });
    return back(`token=${encodeURIComponent(token)}`);
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
