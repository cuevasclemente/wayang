/**
 * @wayang/protocol — shared wire contract between the Wayang backend and
 * companion clients (web frontend, React Native mobile app).
 *
 * Types only: no runtime code, no dependencies. See `docs/mobile-app.md` for
 * the full integration contract (auth, origin rules, evolution policy).
 */

export * from "./rest.js";
export * from "./ws.js";
