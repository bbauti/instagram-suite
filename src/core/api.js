// Instagram API — one client for all three tools.
import { HOST, IG_APP_ID, PAGE_SIZE, HASH, EDGE, RATE_LIMIT_RE } from './constants.js';
import { getCookie, sleep, randInt } from './utils.js';

export class RateLimit extends Error {
  constructor(detail) { super('Instagram rate limit / action block'); this.name = 'RateLimit'; this.detail = detail; }
}
export class ApiError extends Error {
  constructor(message, status) { super(message); this.name = 'ApiError'; this.status = status; }
}

export const api = {
  get viewerId() { return getCookie('ds_user_id'); },
  get csrf() { return getCookie('csrftoken'); },
  get loggedIn() { return !!this.viewerId && location.hostname === HOST; },
  appHeaders() { return { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest' }; },

  async _fetch(url, opts) {
    let res;
    try { res = await fetch(url, opts); }
    catch (e) { throw new ApiError(`Network failure: ${e?.message}`, 0); }
    const body = await res.json().catch(() => null);
    const text = body ? JSON.stringify(body) : '';
    const flagged = res.status === 429 ||
      body?.feedback_required || body?.spam || body?.checkpoint_url ||
      RATE_LIMIT_RE.some((re) => re.test(text));
    if (flagged) throw new RateLimit(body?.feedback_message || body?.message || `HTTP ${res.status}`);
    if (!res.ok) throw new ApiError(body?.message || `HTTP ${res.status}`, res.status);
    return body;
  },
  request(url) { return this._fetch(url, { credentials: 'include', mode: 'cors', headers: this.appHeaders() }); },
  async friendshipPost(primary, fallback) {
    if (!this.csrf) throw new ApiError('No csrftoken cookie — are you logged in?', 401);
    const opts = {
      method: 'POST', credentials: 'include', mode: 'cors',
      headers: { ...this.appHeaders(), 'content-type': 'application/x-www-form-urlencoded', 'x-csrftoken': this.csrf },
    };
    try { return await this._fetch(primary, opts); }
    catch (err) { if (err instanceof RateLimit) { throw err; } return this._fetch(fallback, opts); }
  },
  follow(userId) {
    return this.friendshipPost(`https://${HOST}/api/v1/friendships/create/${userId}/`, `https://${HOST}/web/friendships/${userId}/follow/`);
  },
  unfollow(userId) {
    return this.friendshipPost(`https://${HOST}/api/v1/friendships/destroy/${userId}/`, `https://${HOST}/web/friendships/${userId}/unfollow/`);
  },

  // Profile info + last 3 posts (web_profile_info)
  async getWebProfile(username) {
    const body = await this.request(`https://${HOST}/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
    const u = body?.data?.user;
    if (!u) throw new ApiError(`Profile "${username}" not found`, 404);
    const media = u.edge_owner_to_timeline_media?.edges || [];
    return {
      id: String(u.id), username: u.username, fullName: u.full_name || '',
      picUrl: u.profile_pic_url || '', picUrlHd: u.profile_pic_url_hd || u.profile_pic_url || '',
      isPrivate: !!u.is_private, isVerified: !!u.is_verified,
      followerCount: u.edge_followed_by?.count ?? 0, followingCount: u.edge_follow?.count ?? 0,
      mutualCount: u.edge_mutual_followed_by?.count ?? 0, postsCount: u.edge_owner_to_timeline_media?.count ?? 0,
      followedByViewer: u.followed_by_viewer ?? null, requestedByViewer: u.requested_by_viewer ?? null,
      posts: media.slice(0, 3).map((e) => ({ thumb: e.node.thumbnail_src || e.node.display_url || '', shortcode: e.node.shortcode || '' })),
    };
  },
  // Friendship status fallback (friendships/show)
  async getFriendship(userId) {
    const body = await this.request(`https://${HOST}/api/v1/friendships/show/${userId}/`);
    return { outgoingRequest: !!body?.outgoing_request, following: !!body?.following };
  },

  _mapGraph(n) {
    return {
      id: String(n.id), username: n.username, fullName: n.full_name || '', picUrl: n.profile_pic_url || '',
      isPrivate: !!n.is_private, isVerified: !!n.is_verified,
      followedByViewer: n.followed_by_viewer ?? null, requestedByViewer: n.requested_by_viewer ?? null, followsViewer: n.follows_viewer ?? null,
    };
  },
  _mapApi(u) {
    return {
      id: String(u.pk ?? u.pk_id), username: u.username, fullName: u.full_name || '', picUrl: u.profile_pic_url || '',
      isPrivate: !!u.is_private, isVerified: !!u.is_verified, followedByViewer: null, requestedByViewer: null, followsViewer: null,
    };
  },
  // One page of followers|following for any user id. GraphQL first, api/v1 fallback.
  async page(kind, after, userId) {
    const id = userId || this.viewerId;
    const vars = { id, include_reel: false, fetch_mutual: false, first: PAGE_SIZE };
    if (after) vars.after = after;
    const url = `https://${HOST}/graphql/query/?query_hash=${HASH[kind]}&variables=${encodeURIComponent(JSON.stringify(vars))}`;
    try {
      const body = await this.request(url);
      const edge = body?.data?.user?.[EDGE[kind]];
      if (!edge) throw new ApiError('bad graphql payload', 0);
      return {
        users: (edge.edges || []).map((e) => this._mapGraph(e.node)),
        next: edge.page_info?.has_next_page ? edge.page_info.end_cursor : null,
        total: edge.count ?? null,
      };
    } catch (err) {
      if (err instanceof RateLimit) throw err;
      return this._pageApi(kind, after, id);
    }
  },
  async _pageApi(kind, after, id) {
    const maxId = after ? `&max_id=${encodeURIComponent(after)}` : '';
    const surface = kind === 'followers' ? '&search_surface=follow_list_page' : '';
    const url = `https://${HOST}/api/v1/friendships/${id}/${kind}/?count=${PAGE_SIZE}${surface}${maxId}`;
    const body = await this.request(url);
    if (!Array.isArray(body?.users)) throw new ApiError('bad api/v1 payload', 0);
    return { users: body.users.map((u) => this._mapApi(u)), next: body.next_max_id || null, total: null };
  },
  // First 5 highlights (title + cover only). api/v1 tray primary, GraphQL fallback.
  async getHighlights(userId) {
    try {
      const body = await this.request(`https://${HOST}/api/v1/highlights/${userId}/highlights_tray/`);
      const tray = body?.tray || [];
      return {
        count: tray.length,
        items: tray.slice(0, 5).map((t) => ({
          id: String(t.id), title: t.title || '',
          cover: t.cover_media?.cropped_image_version?.url || t.cover_media?.image_versions2?.candidates?.[0]?.url || '',
        })),
      };
    } catch (err) {
      if (err instanceof RateLimit) throw err;
      const vars = { user_id: userId, include_chaining: false, include_reel: false, include_suggested_users: false, include_logged_out_extras: false, include_highlight_reels: true, include_live_status: false };
      const body = await this.request(`https://${HOST}/graphql/query/?query_hash=${HASH.highlights}&variables=${encodeURIComponent(JSON.stringify(vars))}`);
      const edges = body?.data?.user?.edge_highlight_reels?.edges || [];
      return {
        count: edges.length,
        items: edges.slice(0, 5).map((e) => ({
          id: String(e.node.id), title: e.node.title || '',
          cover: e.node.cover_media_cropped_thumbnail?.url || e.node.cover_media?.thumbnail_src || '',
        })),
      };
    }
  },
};

// Paginate a whole list (followers|following) of `userId` with human pacing.
export const scanList = async (kind, onProgress, userId, shouldCancel) => {
  const users = [], seen = new Set();
  let after = null, total = null, pages = 0;
  for (;;) {
    const res = await api.page(kind, after, userId);
    if (res.total != null) total = res.total;
    for (const u of res.users) if (!seen.has(u.id)) { seen.add(u.id); users.push(u); }
    pages += 1;
    onProgress(kind, users.length, total);
    if (shouldCancel?.()) throw new Error('cancelled');
    after = res.next;
    if (!after) return users;
    await sleep(pages % 6 === 0 ? randInt(4000, 8000) : randInt(700, 1700));
  }
};
