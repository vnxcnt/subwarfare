import type { VesselProfile } from './VesselProfile.js';

/**
 * Fahrleistungen der Schiffsklassen.
 *
 * Liegt hier und nicht in der Client-Config, weil der **Server** damit rechnet —
 * er ist die Quelle der Wahrheit. Der Client braucht dieselben Zahlen nur für
 * seine Anzeigen (Telegraf) und den Offline-Demobetrieb.
 *
 * ⚠️ `maxForward` ist eine Design-Entscheidung, keine technische: ein echtes
 * U-Boot fährt rund 17 m/s, damit dauert eine Kartenkante 9,8 Minuten. 30 m/s
 * ist Faktor 1,8 darüber — eine typische Gefechtsdistanz von 1–3 km in 30–100 s.
 * Der Wendekreis bleibt beim Ändern konstant, die Bahnform also identisch.
 */
export const DESTROYER: VesselProfile = {
  maxForward: 30,
  maxReverse: -8,
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
