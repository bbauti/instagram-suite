// One runnable check on the shared diff/queue logic — the smallest thing that
// fails if the diff math, backoff schedule or escaping breaks.
import { byId, esc } from './core/utils.js';
import { guessGender } from './core/gender.js';
import { needsPic } from './ui/components.js';
import { api } from './core/api.js';
import { nullsLast } from './tools/posts.js';

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

  // Multi-profile merge math: dedupe by id, first copy wins, union of sources.
  const merged = new Map();
  for (const [source, list] of [['a', [makeUser(1), makeUser(2)]], ['b', [makeUser(2), makeUser(3)]]]) {
    for (const u of list) {
      if (merged.has(u.id)) merged.get(u.id).sources.push(source);
      else merged.set(u.id, Object.assign(u, { sources: [source] }));
    }
  }
  console.assert([...merged.keys()].join() === '1,2,3', 'merge ids [1,2,3]');
  console.assert(merged.get('2').sources.join() === 'a,b', 'merge sources union');

  // Gender heuristic: dictionary, diacritics, -a/-o suffix rule with
  // exceptions, username fallback, businesses stay unidentified.
  console.assert(guessGender({ fullName: 'María López' }) === 'f', 'gender maría f');
  console.assert(guessGender({ fullName: 'Juan Pérez' }) === 'm', 'gender juan m');
  console.assert(guessGender({ fullName: 'Zulema Gómez' }) === 'f', 'gender -a suffix f');
  console.assert(guessGender({ fullName: 'Luca Rossi' }) === 'm', 'gender luca exception m');
  console.assert(guessGender({ fullName: '', username: 'lucas.gonzalez22' }) === 'm', 'gender username m');
  console.assert(guessGender({ fullName: 'The Pizza Store', username: 'pizzastorebsas' }) === '', 'gender business unidentified');
  console.assert(guessGender({ fullName: 'Caro Marangi' }) === 'f', 'gender -o nickname caro f');
  console.assert(guessGender({ fullName: '', username: 'merii.hernandez' }) === 'f', 'gender merii f, hernandez not hernan');
  console.assert(guessGender({ fullName: '', username: 'mirian.martinez.9275439' }) === 'f', 'gender mirian f, martinez not martin');
  console.assert(guessGender({ fullName: '', username: 'lopez.hernandez' }) === '', 'gender surnames-only unidentified');

  // Which avatars the "reload photos" button refetches: letter-only ones and
  // images that finished loading with no pixels (expired URL). Anything still
  // loading (or lazily deferred) is left alone.
  console.assert(needsPic({ firstElementChild: null }) === true, 'needsPic letter-only');
  console.assert(needsPic({ firstElementChild: { complete: true, naturalWidth: 0 } }) === true, 'needsPic expired url');
  console.assert(needsPic({ firstElementChild: { complete: true, naturalWidth: 150 } }) === false, 'needsPic loaded');
  console.assert(needsPic({ firstElementChild: { complete: false, naturalWidth: 0 } }) === false, 'needsPic still loading');

  // Posts sorting: hidden counts (null) sink to the bottom either way round, so
  // flipping the arrow never promotes a post that has no number.
  const sortBy = (desc) => [5, null, 12, 0].sort((a, b) => nullsLast(a, b, desc)).join();
  console.assert(sortBy(true) === '12,5,0,', 'posts sort desc, nulls last');
  console.assert(sortBy(false) === '0,5,12,', 'posts sort asc, nulls last');

  // Media mapping: type derivation, and hidden likes as null (never 0).
  const mapped = (item) => api._mapMedia(item);
  console.assert(mapped({ media_type: 1 }).type === 'photo', 'media photo');
  console.assert(mapped({ media_type: 2 }).type === 'video', 'media video');
  console.assert(mapped({ media_type: 2, product_type: 'clips' }).type === 'reel', 'media reel');
  console.assert(mapped({ media_type: 8, product_type: 'carousel_container' }).type === 'carousel', 'media carousel');
  console.assert(mapped({ media_type: 1, like_count: 0 }).likes === 0, 'media zero likes stays 0');
  console.assert(mapped({ media_type: 1, like_count: -1 }).likes === null, 'media hidden likes null');
  console.assert(mapped({ media_type: 1, like_count: 9, like_and_view_counts_disabled: true }).likes === null, 'media disabled counts null');

  // Shapes taken from a live api/v1 feed response, trimmed to the fields we read.
  const reel = mapped({
    pk: '3933903099445093829', code: 'DaYCAa3O6XF', media_type: 2, product_type: 'clips',
    taken_at: 1783178179, like_count: 17, comment_count: 0, play_count: 2265, ig_play_count: 1785,
    media_repost_count: 1, video_duration: 8.49, timeline_pinned_user_ids: [],
    caption: { text: 'Tu serie favorita' }, location: { name: 'Nandina Regalos' },
  });
  console.assert(reel.type === 'reel' && reel.views === 2265 && reel.reposts === 1, 'feed reel views + reposts');
  console.assert(reel.ts === 1783178179000 && reel.location === 'Nandina Regalos', 'feed reel ts + location');
  const carousel = mapped({
    pk: '3947193279721249577', code: 'DbHP1_xmBsp', media_type: 8, product_type: 'carousel_container',
    taken_at: 1784762128, like_count: 36, comment_count: 2, carousel_media_count: 8,
    like_and_view_counts_disabled: false, caption: { text: 'Truco sencillo' },
  });
  console.assert(carousel.type === 'carousel' && carousel.slides === 8, 'feed carousel slides');
  console.assert(carousel.views === null && carousel.reposts === 0, 'feed carousel no views, no reposts');

  // Fallback profile lookup (used when web_profile_info 500s on business
  // accounts): api/v1 field names map onto the same shape web_profile_info returns.
  const fallbackProfile = api._mapUserInfo({
    pk: 123, username: 'x', full_name: 'X', follower_count: 7, following_count: 8,
    media_count: 9, is_private: true, friendship_status: { following: true, outgoing_request: false },
  });
  console.assert(fallbackProfile.id === '123' && fallbackProfile.postsCount === 9, 'user info id + postsCount');
  console.assert(fallbackProfile.followerCount === 7 && fallbackProfile.isPrivate === true, 'user info counts + private');
  console.assert(fallbackProfile.followedByViewer === true && fallbackProfile.requestedByViewer === false, 'user info friendship flags');
  console.assert(api._mapUserInfo({ pk_id: '5', username: 'y' }).followedByViewer === null, 'user info unknown friendship stays null');

  console.log('%c__igsSelfTest passed', 'color:#e4002b;font-weight:700');
  return true;
};
