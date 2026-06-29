// Shared mutable app state. `root`/`view` are the overlay's DOM roots; `active`
// is the mounted tool. Centralised here so UI helpers (toast/scanOverlay) and
// the shell can read the same references without a circular import.
export const app = { root: null, view: null, active: null };
