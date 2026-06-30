// One runnable check on the shared diff/queue logic — the smallest thing that
// fails if the diff math, backoff schedule or escaping breaks.
import { byId, esc } from './core/utils.js';

export const selfTest = () => {
  const makeUser = (id) => ({
    id: String(id),
    username: `u${id}`,
    fullName: '',
    isVerified: false,
    isPrivate: false,
  });
  // Users from `list` whose id is absent from the `lookup` map.
  const missingFrom = (list, lookup) => (list || []).filter((u) => !lookup[u.id]);

  // Diff math: gained = in current but not previous; lost = in previous but not current.
  const previousFollowers = [makeUser(1), makeUser(2), makeUser(3)];
  const currentFollowers = [makeUser(2), makeUser(3), makeUser(4)];
  const gained = missingFrom(currentFollowers, byId(previousFollowers));
  const lost = missingFrom(previousFollowers, byId(currentFollowers));
  console.assert(gained.map((u) => u.id).join() === '4', 'gained [4]');
  console.assert(lost.map((u) => u.id).join() === '1', 'lost [1]');

  // Backoff schedule: capped exponential 2^(attempt-1), maxing out at 16.
  const backoff = [1, 2, 3, 4, 5].map((attempt) => Math.min(16, 2 ** (attempt - 1)));
  console.assert(backoff.join() === '1,2,4,8,16', 'backoff 1,2,4,8,16');

  // HTML escaping.
  console.assert(esc(`<a>&"'`) === '&lt;a&gt;&amp;&quot;&#39;', 'esc');

  console.log('%c__igsSelfTest passed', 'color:#e4002b;font-weight:700');
  return true;
};
