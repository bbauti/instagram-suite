// localStorage layer. Degrades to compact records on quota.
// ~5MB ceiling. Move to IndexedDB only if a very large account overflows.
export const store = {
  get(key, fallback) {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : fallback;
    } catch {
      return fallback;
    }
  },

  setRaw(key, obj) {
    localStorage.setItem(key, JSON.stringify(obj));
  },

  save(key, obj) {
    try {
      this.setRaw(key, obj);
      return true;
    } catch {
      // Over quota: retry with a trimmed copy that keeps only the essential
      // fields on the big user arrays.
      try {
        const compact = structuredClone(obj);
        for (const field of ['followers', 'following', 'users']) {
          if (Array.isArray(compact[field])) {
            compact[field] = compact[field].map((u) => ({
              id: u.id,
              username: u.username,
              isVerified: u.isVerified,
              isPrivate: u.isPrivate,
            }));
          }
        }
        compact._compact = true;
        this.setRaw(key, compact);
        return true;
      } catch {
        return false;
      }
    }
  },

  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
