import type {
  LobbyClientToServerEvents,
  LobbyServerToClientEvents,
  QueueTicketPayload,
} from '@subwarfare/shared';
import { io, type Socket } from 'socket.io-client';
import { ref } from 'vue';
import { API_URL, token } from './auth';

type LobbySocket = Socket<LobbyServerToClientEvents, LobbyClientToServerEvents>;

/** Sichtbarer Zustand der Warteschlange fürs Menü. */
export const queueState = ref<'idle' | 'connecting' | 'waiting' | 'ready' | 'error'>('idle');
export const queuePosition = ref<{ position: number; size: number } | null>(null);
export const queueError = ref<string | null>(null);

/**
 * Warum die letzte Partie endete („an anderer Stelle angemeldet", Rauswurf,
 * Verbindungsabriss). Das Menü zeigt es einmal an und löscht es.
 */
export const lastEndReason = ref<string | null>(null);

/**
 * Hinweiszeile der Menü-Shell — gespeist aus `lastEndReason`, der
 * Discord-Verknüpfung und gelöscht beim Auslaufen. Liegt hier statt lokal in
 * einer Komponente, weil Shell (Anzeige) und Auslaufen-Panel (Reset in play())
 * beide zugreifen — ein Prop-Faden quer durchs Menü wäre der schlechtere Weg.
 */
export const menuNotice = ref<string | null>(null);

let socket: LobbySocket | null = null;

/**
 * Das ausgestellte Join-Ticket.
 *
 * Bewusst NUR im Speicher, nicht in `sessionStorage`: das Ticket gilt genau
 * einmal, und ein per Reload wiederbelebtes Ticket wäre garantiert schon
 * verbraucht oder abgelaufen. Nach einem Reload landet man im Menü und stellt
 * sich neu an — das ist der ehrliche Zustand.
 */
let pendingSession: QueueTicketPayload | null = null;

export function hasSession(): boolean {
  return pendingSession !== null;
}

/** Holt das Ticket ab und verbraucht es dabei — es gilt ohnehin nur einmal. */
export function takeSession(): QueueTicketPayload | null {
  const session = pendingSession;
  pendingSession = null;
  return session;
}

/** In die Warteschlange einreihen. Führt bei freiem Platz direkt zum Ticket. */
export function joinQueue(mapId: string, shipId: string, onTicket: () => void): void {
  if (!token.value) return;
  leaveQueue();

  queueState.value = 'connecting';
  queueError.value = null;
  queuePosition.value = null;

  // Namespace `/lobby` auf dem Backend; `path` muss zeichengenau zum Server
  // passen, sonst scheitert schon der Handshake.
  socket = io(`${API_URL}/lobby`, {
    path: '/api/socket.io',
    auth: { token: token.value },
    transports: ['websocket'],
    reconnection: false,
  });

  socket.on('connect', () => {
    socket?.emit('queue:join', { mapId, shipId });
  });

  socket.on('connect_error', (error) => {
    queueState.value = 'error';
    queueError.value = error.message || 'Lobby ist nicht erreichbar.';
  });

  socket.on('queue:update', (payload) => {
    queueState.value = 'waiting';
    queuePosition.value = { position: payload.position, size: payload.size };
  });

  socket.on('queue:error', (payload) => {
    queueState.value = 'error';
    queueError.value = payload.message;
  });

  socket.on('queue:ticket', (payload) => {
    pendingSession = payload;
    queueState.value = 'ready';
    // Die Lobby-Verbindung hat ihren Zweck erfüllt. Trennen, BEVOR die Ansicht
    // wechselt — sonst hielte jeder Spieler auf der Karte dauerhaft eine
    // zweite, nutzlose Verbindung zum Backend offen.
    leaveQueue(false);
    onTicket();
  });

  socket.on('disconnect', () => {
    // Nur relevant, wenn die Verbindung ohne Ticket wegbricht.
    if (queueState.value === 'waiting' || queueState.value === 'connecting') {
      queueState.value = 'error';
      queueError.value = 'Verbindung zur Lobby verloren.';
    }
  });
}

/** Warteschlange verlassen und die Verbindung schließen. */
export function leaveQueue(resetState = true): void {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  if (resetState) {
    queueState.value = 'idle';
    queuePosition.value = null;
    queueError.value = null;
  }
}
