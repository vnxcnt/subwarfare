/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Basis-URL des Backends, z. B. `http://localhost:8090`. Leer oder
   * weggelassen bedeutet gleiche Herkunft (VPS hinter dem Reverse-Proxy).
   */
  readonly VITE_API_URL?: string;
  /** Google-OAuth-Client-ID. Ohne sie erscheint der Google-Knopf nicht. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
