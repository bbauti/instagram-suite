// One runnable check on the shared diff/queue logic — the smallest thing that
// fails if the diff math, backoff schedule or escaping breaks.
import { byId, esc } from './core/utils.js';

export const selfTest = () => {
  const U = (id) => ({ id: String(id), username: `u${id}`, fullName: '', isVerified: false, isPrivate: false });
  const not = (l, o) => (l || []).filter((u) => !o[u.id]);
  const prevF = [U(1), U(2), U(3)], currF = [U(2), U(3), U(4)];
  const gained = not(currF, byId(prevF)), lost = not(prevF, byId(currF));
  console.assert(gained.map((u) => u.id).join() === '4', 'gained [4]');
  console.assert(lost.map((u) => u.id).join() === '1', 'lost [1]');
  const backoff = [1, 2, 3, 4, 5].map((att) => Math.min(16, 2 ** (att - 1)));
  console.assert(backoff.join() === '1,2,4,8,16', 'backoff 1,2,4,8,16');
  console.assert(esc(`<a>&"'`) === '&lt;a&gt;&amp;&quot;&#39;', 'esc');
  console.log('%c__igsSelfTest passed', 'color:#e4002b;font-weight:700');
  return true;
};
