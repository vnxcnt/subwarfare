import type { VesselProfile } from './VesselProfile.js';

/**
 * Fahrleistungen der Schiffsklassen.
 *
 * Liegt hier und nicht in der Client-Config, weil der **Server** damit rechnet —
 * er ist die Quelle der Wahrheit. Der Client braucht dieselben Zahlen nur für
 * seine Anzeigen (Telegraf) und den Offline-Demobetrieb.
 *
 * ⚠️ `maxForward` ist eine Design-Entscheidung, keine technische: ein echtes
 * U-Boot fährt rund 17 m/s. 34,5 m/s ist die Grundgeschwindigkeit für
 * speed-Faktor 1 der ships-Tabelle (30 × 1,15 seit 2026-08-10, +15 % auf
 * Wunsch; Rückwärtsfahrt proportional mit, damit das Handling gleich bleibt).
 * Der Wendekreis bleibt beim Ändern konstant, die Bahnform also identisch.
 */
export const DESTROYER: VesselProfile = {
  maxForward: 34.5,
  maxReverse: -9.2,
  accel: 1.0,
  brake: 2.0,
  drag: 0.45,
  turnRadius: 220,
  thrusterRate: 3,
  maxTurnRate: 8,
  rudderAuthority: 25,
  arriveRadius: 25,
  /** 4 km — passt zu den Entfernungsringen des Sonar-Rundsichtgeräts. */
  sensorRange: 4_000,
};

/** Simulationstakt. Client und Server müssen denselben Schritt fahren. */
export const SIM_STEP_SECONDS = 0.05;
