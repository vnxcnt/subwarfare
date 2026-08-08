/** WebSocket-Endpunkt des Game-Servers. Über `VITE_GAME_SERVER_URL` überschreibbar. */
export const GAME_SERVER_URL = import.meta.env.VITE_GAME_SERVER_URL ?? 'ws://localhost:8080';

/** Startwerte für den PixiJS-Renderer. */
export const RENDERER = {
  /** Tiefes Ozeanblau als leere Spielfläche. */
  backgroundColor: 0x04141f,
  antialias: true,
  /** WebGL statt WebGPU — breitere Browser-Abdeckung. */
  preference: 'webgl',
} as const;
