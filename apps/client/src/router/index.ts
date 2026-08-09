import { createRouter, createWebHistory } from 'vue-router';
import { isLoggedIn, restoreSession } from '../state/auth';
import { hasSession } from '../state/lobby';
import LoginView from '../views/LoginView.vue';
import MenuView from '../views/MenuView.vue';
import PlayView from '../views/PlayView.vue';

/**
 * Drei Stationen: Anmeldung → Hauptmenü → Karte.
 *
 * Die Views sind statisch importiert statt lazy: das ist EIN Spiel, kein
 * Seitenbündel — wer die Anmeldung lädt, lädt in derselben Minute auch die
 * Karte. Ein Splitpunkt würde nur den Moment des „Spielen"-Klicks verzögern.
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/login' },
    { path: '/login', name: 'login', component: LoginView },
    { path: '/menu', name: 'menu', component: MenuView },
    { path: '/play', name: 'play', component: PlayView },
  ],
});

/** Einmalige Sitzungswiederherstellung beim ersten Seitenaufruf. */
let restored: Promise<boolean> | null = null;

router.beforeEach(async (to) => {
  // Offline braucht weder Konto noch Server — bewusst VOR der Anmeldeprüfung,
  // damit der Demobetrieb auch ohne laufendes Backend erreichbar bleibt.
  if (to.name === 'play' && to.query['offline'] === '1') return true;

  restored ??= restoreSession();
  await restored;

  if (to.name === 'login') {
    return isLoggedIn() ? { name: 'menu' } : true;
  }

  if (!isLoggedIn()) return { name: 'login' };

  if (to.name === 'play' && !hasSession()) {
    // Auf die Karte führt nur ein frisches Ticket aus der Lobby. Ein Reload
    // landet deshalb im Menü: das alte Ticket wäre ohnehin verbraucht.
    return { name: 'menu' };
  }

  return true;
});
