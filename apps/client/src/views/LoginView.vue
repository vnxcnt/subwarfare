<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  adoptToken,
  authMethods,
  consumeOauthNonce,
  discordLoginUrl,
  loadAuthMethods,
  loginDev,
  loginGoogle,
  restoreSession,
} from '../state/auth';
import { ensureGis } from '../ui/gis';
import logoUrl from '../assets/ui/logo_main_white_login.png';

const router = useRouter();
const name = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

/**
 * Der Entwickler-Zugang existiert ausschließlich im Dev-Build — Vite ersetzt
 * die Konstante zur Bauzeit, im Produktionsbundle fällt der ganze Zweig weg.
 */
const IS_DEV_BUILD: boolean = import.meta.env.DEV;

/* --- Google-Login (GIS-Button) ------------------------------------------ */

/**
 * Die Client-ID ist BAUZEIT-Konfiguration (Vite), ob Google aktiv ist, sagt
 * der SERVER (/auth/methods) — der Button erscheint nur, wenn beides passt.
 * Die ID ist nicht geheim; geprüft wird das ID-Token server-seitig.
 */
const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

const googleSlot = ref<HTMLElement | null>(null);
let googleReady = false;

/**
 * Lädt das GIS-Skript erst, wenn der Server Google anbietet — wer nur Discord
 * fährt, lädt keinen Google-Code. Danach den Button in den Slot rendern.
 */
async function mountGoogleButton(): Promise<void> {
  if (googleReady || !GOOGLE_CLIENT_ID || !authMethods.value?.google || !googleSlot.value) return;
  const id = await ensureGis();
  const slot = googleSlot.value;
  if (!id || !slot || googleReady) return;
  googleReady = true;
  id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onGoogleCredential });
  /*
   * Breite GEMESSEN statt geraten: der Slot spannt exakt die Innenbreite des
   * Panels auf — dieselbe, die der Discord-Knopf füllt. Die festen 320 px von
   * früher waren durch den 26-px-Goldrahmen breiter als der Discord-Knopf
   * (Innenbreite ~306 px) und standen sichtbar über. GIS deckelt bei 400.
   */
  const breite = Math.min(Math.max(Math.round(slot.clientWidth), 200), 400) || 320;
  id.renderButton(slot, { theme: 'outline', size: 'large', text: 'signin_with', width: breite });
}

/** Rücklauf des GIS-Buttons: das ID-Token geht zur Prüfung an unseren Server. */
function onGoogleCredential(response: { credential: string }): void {
  void (async () => {
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    const failure = await loginGoogle(response.credential);
    busy.value = false;
    if (failure) {
      error.value = failure;
      return;
    }
    await router.replace({ name: 'menu' });
  })();
}

// /auth/methods kommt asynchron — sobald Google gemeldet ist, Button bauen.
// flush: 'post', weil der Slot selbst per v-if an den methods hängt und erst
// NACH dem DOM-Update existiert.
watch(authMethods, () => void mountGoogleButton(), { flush: 'post' });

/**
 * Rücklauf des Discord-Logins: Token oder Fehler stehen im URL-Fragment.
 * Das Fragment sofort aus der Adresszeile entfernen — es hat in Verlauf und
 * Lesezeichen nichts verloren.
 */
async function consumeOauthFragment(): Promise<void> {
  if (!location.hash) return;
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('token');
  const failure = fragment.get('error');
  if (!token && !failure) return;

  history.replaceState(null, '', location.pathname + location.search);

  if (failure) {
    error.value = failure;
    return;
  }
  // Wiedererkennung prüfen, BEVOR ein fremdes Token übernommen wird: nur der
  // Browser, der den Absprung gestartet hat, kennt die Nonce.
  if (!consumeOauthNonce(fragment.get('n'))) {
    error.value = 'Diese Anmeldung wurde nicht von diesem Browser gestartet.';
    return;
  }
  if (token) {
    busy.value = true;
    adoptToken(token);
    const ok = await restoreSession();
    busy.value = false;
    if (ok) await router.replace({ name: 'menu' });
    else error.value = 'Anmeldung wurde vom Server nicht angenommen.';
  }
}

async function submitDev(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  const failure = await loginDev(name.value.trim());
  busy.value = false;
  if (failure) {
    error.value = failure;
    return;
  }
  await router.replace({ name: 'menu' });
}

onMounted(() => {
  void consumeOauthFragment();
  void loadAuthMethods();
  // Auch hier anstoßen: `authMethods` überlebt als Modul-Zustand einen
  // Abmelde-Zyklus, dann rendert das Template den Slot sofort und der watch
  // (der nur auf ÄNDERUNG feuert) käme nie.
  void mountGoogleButton();
});
</script>

<template>
  <div class="login game-cursor">
    <section class="gold-panel login__panel">
      <!-- Offizielles Logo statt Schriftzug; das alt hält den Namen für
           Screenreader und den Fall, dass das Bild nicht lädt. -->
      <h1 class="login__title">
        <img class="login__logo" :src="logoUrl" alt="Sub Warfare" />
      </h1>
      <p class="login__subtitle">Anmeldung</p>

      <a
        v-if="authMethods?.discord"
        class="login__discord"
        :href="discordLoginUrl()"
      >
        <svg class="login__discord-mark" viewBox="0 0 127.14 96.36" aria-hidden="true">
          <path
            fill="currentColor"
            d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z"
          />
        </svg>
        Mit Discord anmelden
      </a>

      <!-- Google (GIS-Button): erscheint nur, wenn der Server Google anbietet
           UND der Build eine Client-ID trägt — der Slot wird von GIS gefüllt. -->
      <template v-if="authMethods?.google && GOOGLE_CLIENT_ID">
        <div v-if="authMethods?.discord" class="login__divider login__divider--gap"><span>oder</span></div>
        <div ref="googleSlot" class="login__google"></div>
      </template>

      <!--
        Entwickler-Zugang NUR im Dev-Build (Vite ersetzt import.meta.env.DEV
        zur Bauzeit — im Produktionsbundle existiert dieser Zweig nicht).
        Lokal bleibt er das Werkzeug, um ohne Discord-Redirect zu arbeiten;
        der Server lehnt ihn produktiv ohnehin ab (AUTH_DEV=0).
      -->
      <template v-if="IS_DEV_BUILD && authMethods?.dev">
        <div v-if="authMethods?.discord || authMethods?.google" class="login__divider login__divider--gap"><span>oder</span></div>
        <form class="login__form" @submit.prevent="submitDev">
          <label class="login__label" for="login-name">Entwickler-Zugang (nur Dev-Build)</label>
          <input
            id="login-name"
            v-model="name"
            class="login__input"
            type="text"
            minlength="2"
            maxlength="24"
            placeholder="Anzeigename"
            autocomplete="off"
            required
          />
          <button class="login__button" type="submit" :disabled="busy">
            {{ busy ? 'Anmelden …' : 'Anmelden' }}
          </button>
        </form>
      </template>

      <p v-if="authMethods && !authMethods.discord && !authMethods.google" class="hud__empty">
        Die Anmeldung ist derzeit nicht verfügbar.
      </p>

      <p v-if="error" class="login__error">{{ error }}</p>
    </section>
  </div>
</template>

<style scoped>
.login {
  display: grid;
  place-items: center;
  height: 100%;
  background: url('../assets/ui/login-bg.webp') center / cover no-repeat #04141f;
}

/*
 * Abdunkelung unter dem Panel: das Motiv ist kontrastreich (Sonne, Explosion,
 * Gischt), ohne Schleier hinge die Lesbarkeit des Formulars vom Bildausschnitt
 * und Seitenverhältnis ab. Die Vignette lässt die Ränder wirken und beruhigt
 * die Mitte.
 */
.login::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at center, rgb(4 20 31 / 62%) 0%, rgb(4 20 31 / 28%) 60%, rgb(4 20 31 / 45%) 100%);
  pointer-events: none;
}

.login__panel {
  position: relative;
  width: min(25rem, calc(100vw - 2rem));
  padding: 1.1rem 1.3rem 1rem;
}

.login__title {
  margin: 0;
  display: flex;
  justify-content: center;
}

/*
 * Logo im Panel: knapp schmaler als die Innenbreite, damit es atmet. Die
 * Quelle liegt auf 600 px vorverkleinert (2× der Anzeige) — scharf auf HiDPI,
 * ohne das 380-kB-Original zu schleppen. Der Schatten löst das Weiß vom
 * dunklen Panelgrund.
 */
.login__logo {
  display: block;
  width: min(15rem, 80%);
  height: auto;
  filter: drop-shadow(0 2px 6px rgb(0 0 0 / 55%));
}

.login__subtitle {
  margin: 0.2rem 0 1.2rem;
  text-align: center;
  opacity: 0.55;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 0.6875rem;
}

.login__discord {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.55rem;
  padding: 0.6rem 0.65rem;
  border-radius: 2px;
  /* Discords Markenfarbe „Blurple" — bewusst außerhalb unserer Palette, der
     Knopf soll als Fremd-Login erkennbar sein. */
  background: #5865f2;
  color: #fff;
  font-size: 0.8125rem;
  letter-spacing: 0.05em;
  text-decoration: none;
}

.login__discord:hover {
  background: #4752c4;
}

.login__discord-mark {
  width: 1.1rem;
  height: auto;
}

/* Der GIS-Button bringt sein eigenes Aussehen mit — hier nur zentrieren und
   Platz reservieren, damit das Panel beim Nachladen nicht springt. */
.login__google {
  display: flex;
  justify-content: center;
  min-height: 44px;
}

.login__divider--gap {
  margin-bottom: 1rem;
}

.login__divider {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 1rem;
  opacity: 0.5;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}

.login__divider::before,
.login__divider::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--gold-border);
}

.login__form {
  display: grid;
  gap: 0.6rem;
}

.login__label {
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  opacity: 0.55;
}

.login__input {
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--gold-border);
  border-radius: 0;
  /* Dunkler als die Panelfüllung — das Feld liegt optisch „im" Gehäuse. */
  background: #0c0b09;
  color: #e9e2cd;
  font: inherit;
}

.login__input:focus {
  outline: 1px solid var(--gold);
  outline-offset: -1px;
}

.login__button {
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--gold);
  border-radius: 0;
  background: var(--gold-faint);
  color: var(--gold);
  font: inherit;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
}

.login__button:hover:not(:disabled) {
  background: rgb(230 207 120 / 22%);
}

.login__button:disabled {
  opacity: 0.5;
  cursor: default;
}

.login__error {
  margin: 0.8rem 0 0;
  color: #f4b3b5;
}
</style>
