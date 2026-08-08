/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket-URL des Game-Servers, z. B. `ws://localhost:8080`. */
  readonly VITE_GAME_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
