import type {
  ChatChannel,
  LobbyClientToServerEvents,
  LobbyServerToClientEvents,
  StoredChatMessage,
} from '@subwarfare/shared';
import { CHAT_MAX_LENGTH } from '@subwarfare/shared';
import { io, type Socket } from 'socket.io-client';
import { reactive, ref } from 'vue';
import notifyUrl from '../assets/audio/chat_notify.mp3';
import { API_URL, account, token } from './auth';
import { volumes } from './settings';
import { refreshFriends } from './social';

type ChatSocket = Socket<LobbyServerToClientEvents, LobbyClientToServerEvents>;

export interface ChatLine {
  id: number;
  /** Konto des Absenders — macht den Namen klickbar (Profil). */
  senderId: string | null;
  name: string;
  text: string;
  /** Spielstufe des Absenders — fürs Rang-Abzeichen vor dem Namen. */
  level: number;
  /** Kontorolle des Absenders — färbt den Namen (Dev/GM/Mod). */
  role: number;
}

/**
 * Gesprächsfaden-Schlüssel: die beiden festen Kanäle plus ein Faden je
 * Privat-Gesprächspartner.
 */
export type ThreadKey = 'hafen' | 'flottille' | `privat:${string}`;

export function privatKey(partnerId: string): ThreadKey {
  return `privat:${partnerId}`;
}

/**
 * Funkraum über den `/lobby`-Namespace.
 *
 * EIGENE Verbindung neben der Warteschlange: die Queue baut ihren Socket pro
 * Anstellen auf und reißt ihn mit dem Ticket ab — der Funk dagegen lebt genau
 * so lange wie die Menü-Ansicht. Der Hafen bleibt flüchtig; Flottille und
 * Privat laden ihre Geschichte per REST nach (`loadHistory`), Live-Zeilen
 * kommen für alle Kanäle über denselben Socket.
 */
export const threads = reactive<Partial<Record<ThreadKey, ChatLine[]>>>({});
export const chatConnected = ref(false);

/** Mehr braucht kein Menü-Chat — Ältestes fällt vorne raus. */
const MAX_LINES = 80;

let socket: ChatSocket | null = null;
let nextId = 1;

/**
 * Benachrichtigungston für EINGEHENDE Zeilen in Flottille und Privat — der
 * Hafen bleibt stumm (Dauerfunk aller Verbundenen wäre Dauerklingeln), und
 * die eigenen Zeilen (Server-Echo) klingeln nicht. Läuft über den
 * Effekte-Regler; scheitert das Abspielen (Autoplay vor der ersten Geste),
 * fällt es still aus.
 */
const NOTIFY_VOLUME = 0.5;
let notifySound: HTMLAudioElement | null = null;

function playNotify(): void {
  notifySound ??= new Audio(notifyUrl);
  notifySound.volume = Math.min(1, NOTIFY_VOLUME * volumes.value.effects);
  notifySound.currentTime = 0;
  notifySound.play().catch(() => {});
}

export function threadLines(key: ThreadKey): ChatLine[] {
  return (threads[key] ??= []);
}

function push(key: ThreadKey, line: Omit<ChatLine, 'id'>): void {
  const liste = threadLines(key);
  liste.push({ ...line, id: nextId++ });
  if (liste.length > MAX_LINES) liste.splice(0, liste.length - MAX_LINES);
}

export function connectChat(): void {
  if (socket || !token.value) return;

  socket = io(`${API_URL}/lobby`, {
    path: '/api/socket.io',
    auth: { token: token.value },
    transports: ['websocket'],
    // Anders als die Queue DARF der Chat wiederkommen — eine kurze Störung
    // soll das Mitlesen nicht bis zum nächsten Menübesuch beenden.
    reconnection: true,
    reconnectionAttempts: 5,
  });

  socket.on('connect', () => {
    chatConnected.value = true;
  });
  socket.on('disconnect', () => {
    chatConnected.value = false;
  });
  socket.on('chat:message', (payload) => {
    const channel: ChatChannel = payload.channel ?? 'hafen';
    let key: ThreadKey = 'hafen';
    if (channel === 'flottille') key = 'flottille';
    if (channel === 'privat') {
      // Der Faden gehört zum GESPRÄCHSPARTNER: bei eigenen Zeilen ist das
      // der Empfänger, bei fremden der Absender.
      const meineId = account.value?.id ?? null;
      const partner = payload.senderId === meineId ? payload.to : payload.senderId;
      if (!partner) return;
      key = privatKey(partner);
    }
    push(key, {
      senderId: payload.senderId ?? null,
      name: payload.name,
      text: payload.text,
      level: payload.level ?? 1,
      role: payload.role ?? 0,
    });
    if (channel !== 'hafen' && payload.senderId !== account.value?.id) playNotify();
  });
  // Freundschafts-Stand hat sich drüben geändert — Liste nachziehen.
  socket.on('social:update', () => void refreshFriends());
  // Moderation hat die Nachrichten eines Kontos gelöscht — aus ALLEN Fäden
  // entfernen (die gespeicherten Kanäle hat der Server bereits geräumt).
  socket.on('chat:purge', (payload) => {
    for (const key of Object.keys(threads) as ThreadKey[]) {
      const liste = threads[key];
      if (liste) threads[key] = liste.filter((zeile) => zeile.senderId !== payload.accountId);
    }
  });
}

export function disconnectChat(): void {
  chatConnected.value = false;
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

/** Schickt eine Zeile. Leeres verwirft der Client, den Rest prüft der Server. */
export function sendChat(text: string, channel: ChatChannel = 'hafen', to?: string): void {
  const gekuerzt = text.trim().slice(0, CHAT_MAX_LENGTH);
  if (gekuerzt.length === 0) return;
  socket?.emit('chat:send', { text: gekuerzt, channel, to });
}

/**
 * Lädt die gespeicherte Geschichte eines Fadens und ERSETZT die lokale Liste
 * damit — Live-Zeilen hängen sich danach wieder normal an. Für den Hafen gibt
 * es keine Geschichte (flüchtig per Bauart).
 */
export async function loadHistory(key: ThreadKey): Promise<void> {
  if (key === 'hafen') return;
  const partner = key.startsWith('privat:') ? key.slice('privat:'.length) : null;
  const query = partner
    ? `channel=privat&with=${encodeURIComponent(partner)}`
    : 'channel=flottille';
  try {
    const headers = new Headers();
    if (token.value) headers.set('authorization', `Bearer ${token.value}`);
    const response = await fetch(`${API_URL}/api/social/messages?${query}`, { headers });
    if (!response.ok) return;
    const data = (await response.json()) as { messages: StoredChatMessage[] };
    threads[key] = data.messages.map((zeile) => ({
      id: nextId++,
      senderId: zeile.senderId,
      name: zeile.name,
      text: zeile.text,
      level: zeile.level,
      role: zeile.role,
    }));
  } catch {
    // Der Faden zeigt dann eben nur Live-Zeilen — Menü bleibt benutzbar.
  }
}
