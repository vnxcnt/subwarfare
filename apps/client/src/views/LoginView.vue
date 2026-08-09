<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  adoptToken,
  authMethods,
  discordLoginUrl,
  loadAuthMethods,
  loginDev,
  loginGoogle,
  restoreSession,
} from '../state/auth';

const router = useRouter();
const name = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const googleHost = ref<HTMLDivElement | null>(null);

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
  if (token) {
    busy.value = true;
    adoptToken(token);
    const ok = await restoreSession();
    busy.value = false;
    if (ok) await router.replace({ name: 'menu' });
    else error.value = 'Anmeldung wurde vom Server nicht angenommen.';
  }
}

/**
 * Google Identity Services. Aktiv nur, wenn eine Client-ID gesetzt ist —
 * Google akzeptiert keine nackten IP-Adressen als Herkunft, der Knopf käme
 * auf dem VPS ohne Domain also gar nicht erst zum Laufen.
 */
const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }): void;
          renderButton(host: HTMLElement, options: Record<string, unknown>): void;
        };
      };
    };
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

async function handleGoogleCredential(credential: string): Promise<void> {
  busy.value = true;
  error.value = null;
  const failure = await loginGoogle(credential);
  busy.value = false;
  if (failure) {
    error.value = failure;
    return;
  }
  await router.replace({ name: 'menu' });
}

function mountGoogleButton(): void {
  if (!GOOGLE_CLIENT_ID || !googleHost.value) return;

  const render = (): void => {
    window.google?.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: (response) => void handleGoogleCredential(response.credential),
    });
    window.google?.accounts.id.renderButton(googleHost.value!, {
      theme: 'filled_black',
      size: 'large',
      text: 'signin_with',
      width: 280,
    });
  };

  if (window.google) {
    render();
    return;
  }
  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.async = true;
  script.onload = render;
  document.head.appendChild(script);
}

onMounted(() => {
  void consumeOauthFragment();
  void loadAuthMethods();
  mountGoogleButton();
});
</script>

<template>
  <div class="login">
    <section class="hud__panel login__panel">
      <h1 class="login__title">Sub Warfare</h1>
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
      <div v-if="authMethods?.discord && (GOOGLE_CLIENT_ID || authMethods.dev)" class="login__divider login__divider--gap"><span>oder</span></div>

      <div v-if="GOOGLE_CLIENT_ID" class="login__google">
        <div ref="googleHost"></div>
        <div class="login__divider"><span>oder</span></div>
      </div>

      <form
        v-if="authMethods === null || authMethods.dev"
        class="login__form"
        @submit.prevent="submitDev"
      >
        <label class="login__label" for="login-name">Entwickler-Zugang</label>
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
      <p v-else-if="!GOOGLE_CLIENT_ID" class="hud__empty">
        Dieser Server bietet derzeit keinen Anmeldeweg an.
      </p>

      <p v-if="error" class="login__error">{{ error }}</p>

      <button class="login__offline" type="button" @click="router.push('/play?offline=1')">
        Offline-Modus (ohne Konto)
      </button>
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
  width: min(22rem, calc(100vw - 2rem));
  padding: 1.5rem 1.75rem 1.25rem;
  /* Vor dem Foto braucht das Panel mehr Deckung als über der Wasserfläche. */
  background: rgb(4 20 31 / 88%);
  backdrop-filter: blur(6px);
}

.login__title {
  margin: 0;
  font-size: 1.5rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ui-accent);
}

.login__subtitle {
  margin: 0.2rem 0 1.2rem;
  opacity: 0.55;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 0.6875rem;
}

.login__google {
  margin-bottom: 1rem;
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

.login__divider--gap {
  margin-bottom: 1rem;
}

.login__divider {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 1rem;
  opacity: 0.4;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}

.login__divider::before,
.login__divider::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--ui-border);
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
  border: 1px solid var(--ui-border);
  border-radius: 2px;
  background: rgb(4 20 31 / 85%);
  color: var(--ui-text);
  font: inherit;
}

.login__input:focus {
  outline: 1px solid var(--ui-accent);
  outline-offset: -1px;
}

.login__button {
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--ui-accent);
  border-radius: 2px;
  background: rgb(111 208 189 / 12%);
  color: var(--ui-accent);
  font: inherit;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
}

.login__button:hover:not(:disabled) {
  background: rgb(111 208 189 / 22%);
}

.login__button:disabled {
  opacity: 0.5;
  cursor: default;
}

.login__error {
  margin: 0.8rem 0 0;
  color: #f4b3b5;
}

.login__offline {
  margin-top: 1.2rem;
  padding: 0;
  border: none;
  background: none;
  color: var(--ui-text);
  font: inherit;
  font-size: 0.75rem;
  opacity: 0.45;
  cursor: pointer;
  text-decoration: underline;
}

.login__offline:hover {
  opacity: 0.8;
}
</style>
