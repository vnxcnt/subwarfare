import type {
  LobbyClientToServerEvents,
  LobbyServerToClientEvents,
} from '@subwarfare/shared';
import { CHAT_MAX_LENGTH } from '@subwarfare/shared';
import { io, type Socket } from 'socket.io-client';
import { ref } from 'vue';
import { API_URL, token } from './auth';

type ChatSocket = Socket<LobbyServerToClientEvents, LobbyClientToServerEvents>;

export interface ChatLine {
  id: number;
  name: string;
  text: string;
}

/**
 * Hauptmenü-Chat über den `/lobby`-Namespace.
 *
 * EIGENE Verbindung neben der Warteschlange: die Queue baut ihren Socket pro
 * Anstellen auf und reißt ihn mit dem Ticket ab — der Chat dagegen lebt genau
 * so lange wie die Menü-Ansicht. Beide teilen sich den Namespace, der Server
 * unterscheidet sie nicht.
 *
 * Nichts wird gespeichert: die Liste lebt im Speicher dieser Sitzung, und wer
 * das Menü betritt, liest ab da mit — Geschichte gibt es nicht.
 */
export const chatLines = ref<ChatLine[]>([]);
export const chatConnected = ref(false);

/** Mehr braucht kein Menü-Chat — Ältestes fällt vorne raus. */
const MAX_LINES = 80;

let socket: ChatSocket | null = null;
let nextId = 1;

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
    chatLines.value.push({ id: nextId++, name: payload.name, text: payload.text });
    if (chatLines.value.length > MAX_LINES) {
      chatLines.value.splice(0, chatLines.value.length - MAX_LINES);
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
export function sendChat(text: string): void {
  const gekuerzt = text.trim().slice(0, CHAT_MAX_LENGTH);
  if (gekuerzt.length === 0) return;
  socket?.emit('chat:send', { text: gekuerzt });
}
