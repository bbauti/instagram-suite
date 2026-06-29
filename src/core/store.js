// localStorage layer. Degrades to compact records on quota.
// ponytail: ~5MB ceiling. Move to IndexedDB only if a very large account overflows.
export const store = {
  get(key, dflt) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; }
    catch { return dflt; }
  },
  setRaw(key, obj) { localStorage.setItem(key, JSON.stringify(obj)); },
  save(key, obj) {
    try { this.setRaw(key, obj); return true; }
    catch {
      try {
        const compact = structuredClone(obj);
        for (const k of ['followers', 'following', 'users']) {
          if (Array.isArray(compact[k])) {
            compact[k] = compact[k].map((u) => ({ id: u.id, username: u.username, isVerified: u.isVerified, isPrivate: u.isPrivate }));
          }
        }
        compact._compact = true;
        this.setRaw(key, compact);
        return true;
      } catch { return false; }
    }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};
