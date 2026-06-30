// Instagram API — one client for all three tools.
import { HOST, IG_APP_ID, PAGE_SIZE, HASH, EDGE, RATE_LIMIT_RE } from './constants.js';
import { getCookie, sleep, randInt } from './utils.js';

// Thrown when Instagram signals a rate limit / temporary action block.
export class RateLimit extends Error {
  constructor(detail) {
    super('Instagram rate limit / action block');
    this.name = 'RateLimit';
    this.detail = detail;
  }
}
// Thrown for ordinary HTTP / network failures (carries the HTTP status).
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export const api = {
  // ── auth / session ──
  get viewerId() { return getCookie('ds_user_id'); },
  get csrf() { return getCookie('csrftoken'); },
  get loggedIn() { return !!this.viewerId && location.hostname === HOST; },
  appHeaders() { return { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest' }; },

  // ── low-level fetch (rate-limit detection lives here) ──
  async _fetch(url, opts) {
    let response;
    try {
      response = await fetch(url, opts);
    } catch (err) {
      throw new ApiError(`Network failure: ${err?.message}`, 0);
    }
    const body = await response.json().catch(() => null);
    const bodyText = body ? JSON.stringify(body) : '';
    const flagged = response.status === 429 ||
      body?.feedback_required || body?.spam || body?.checkpoint_url ||
      RATE_LIMIT_RE.some((re) => re.test(bodyText));
    if (flagged) throw new RateLimit(body?.feedback_message || body?.message || `HTTP ${response.status}`);
    if (!response.ok) throw new ApiError(body?.message || `HTTP ${response.status}`, response.status);
    return body;
  },
  request(url) {
    return this._fetch(url, { credentials: 'include', mode: 'cors', headers: this.appHeaders() });
  },

  // ── friendship actions (follow / unfollow) ──
  async friendshipPost(primary, fallback) {
    if (!this.csrf) throw new ApiError('No csrftoken cookie — are you logged in?', 401);
    const opts = {
      method: 'POST', credentials: 'include', mode: 'cors',
      headers: { ...this.appHeaders(), 'content-type': 'application/x-www-form-urlencoded', 'x-csrftoken': this.csrf },
    };
    try {
      return await this._fetch(primary, opts);
    } catch (err) {
      // A rate limit is fatal here; any other error retries the web endpoint.
      if (err instanceof RateLimit) { throw err; }
      return this._fetch(fallback, opts);
    }
  },
  follow(userId) {
    return this.friendshipPost(`https://${HOST}/api/v1/friendships/create/${userId}/`, `https://${HOST}/web/friendships/${userId}/follow/`);
  },
  unfollow(userId) {
    return this.friendshipPost(`https://${HOST}/api/v1/friendships/destroy/${userId}/`, `https://${HOST}/web/friendships/${userId}/unfollow/`);
  },

  // ── profile lookups ──
  // Profile info + last 3 posts (web_profile_info)
  async getWebProfile(username) {
    const body = await this.request(`https://${HOST}/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
    const user = body?.data?.user;
    if (!user) throw new ApiError(`Profile "${username}" not found`, 404);
    const media = user.edge_owner_to_timeline_media?.edges || [];
    return {
      id: String(user.id),
      username: user.username,
      fullName: user.full_name || '',
      picUrl: user.profile_pic_url || '',
      picUrlHd: user.profile_pic_url_hd || user.profile_pic_url || '',
      isPrivate: !!user.is_private,
      isVerified: !!user.is_verified,
      followerCount: user.edge_followed_by?.count ?? 0,
      followingCount: user.edge_follow?.count ?? 0,
      mutualCount: user.edge_mutual_followed_by?.count ?? 0,
      postsCount: user.edge_owner_to_timeline_media?.count ?? 0,
      followedByViewer: user.followed_by_viewer ?? null,
      requestedByViewer: user.requested_by_viewer ?? null,
      posts: media.slice(0, 3).map((edge) => ({
        thumb: edge.node.thumbnail_src || edge.node.display_url || '',
        shortcode: edge.node.shortcode || '',
      })),
    };
  },
  // Friendship status fallback (friendships/show)
  async getFriendship(userId) {
    const body = await this.request(`https://${HOST}/api/v1/friendships/show/${userId}/`);
    return { outgoingRequest: !!body?.outgoing_request, following: !!body?.following };
  },

  // ── user mappers (normalise GraphQL vs api/v1 shapes) ──
  _mapGraph(node) {
    return {
      id: String(node.id),
      username: node.username,
      fullName: node.full_name || '',
      picUrl: node.profile_pic_url || '',
      isPrivate: !!node.is_private,
      isVerified: !!node.is_verified,
      followedByViewer: node.followed_by_viewer ?? null,
      requestedByViewer: node.requested_by_viewer ?? null,
      followsViewer: node.follows_viewer ?? null,
    };
  },
  _mapApi(user) {
    return {
      id: String(user.pk ?? user.pk_id),
      username: user.username,
      fullName: user.full_name || '',
      picUrl: user.profile_pic_url || '',
      isPrivate: !!user.is_private,
      isVerified: !!user.is_verified,
      followedByViewer: null,
      requestedByViewer: null,
      followsViewer: null,
    };
  },

  // ── pagination ──
  // One page of followers|following for any user id. GraphQL first, api/v1 fallback.
  async page(kind, after, userId) {
    const id = userId || this.viewerId;
    const vars = { id, include_reel: false, fetch_mutual: false, first: PAGE_SIZE };
    if (after) vars.after = after;
    const url = `https://${HOST}/graphql/query/?query_hash=${HASH[kind]}&variables=${encodeURIComponent(JSON.stringify(vars))}`;
    try {
      const body = await this.request(url);
      // `connection` is the relay-style edge container ({ edges, page_info, count }).
      const connection = body?.data?.user?.[EDGE[kind]];
      if (!connection) throw new ApiError('bad graphql payload', 0);
      return {
        users: (connection.edges || []).map((edge) => this._mapGraph(edge.node)),
        next: connection.page_info?.has_next_page ? connection.page_info.end_cursor : null,
        total: connection.count ?? null,
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
    return { users: body.users.map((user) => this._mapApi(user)), next: body.next_max_id || null, total: null };
  },

  // ── highlights ──
  // First 5 highlights (title + cover only). api/v1 tray primary, GraphQL fallback.
  async getHighlights(userId) {
    try {
      const body = await this.request(`https://${HOST}/api/v1/highlights/${userId}/highlights_tray/`);
      const tray = body?.tray || [];
      return {
        count: tray.length,
        items: tray.slice(0, 5).map((trayItem) => ({
          id: String(trayItem.id),
          title: trayItem.title || '',
          cover: trayItem.cover_media?.cropped_image_version?.url || trayItem.cover_media?.image_versions2?.candidates?.[0]?.url || '',
        })),
      };
    } catch (err) {
      if (err instanceof RateLimit) throw err;
      const vars = {
        user_id: userId,
        include_chaining: false,
        include_reel: false,
        include_suggested_users: false,
        include_logged_out_extras: false,
        include_highlight_reels: true,
        include_live_status: false,
      };
      const body = await this.request(`https://${HOST}/graphql/query/?query_hash=${HASH.highlights}&variables=${encodeURIComponent(JSON.stringify(vars))}`);
      const edges = body?.data?.user?.edge_highlight_reels?.edges || [];
      return {
        count: edges.length,
        items: edges.slice(0, 5).map((edge) => ({
          id: String(edge.node.id),
          title: edge.node.title || '',
          cover: edge.node.cover_media_cropped_thumbnail?.url || edge.node.cover_media?.thumbnail_src || '',
        })),
      };
    }
  },
};

// Paginate a whole list (followers|following) of `userId` with human pacing.
export const scanList = async (kind, onProgress, userId, shouldCancel) => {
  const users = [];
  const seen = new Set();
  let after = null;
  let total = null;
  let pages = 0;
  for (;;) {
    const pageResult = await api.page(kind, after, userId);
    if (pageResult.total != null) total = pageResult.total;
    for (const u of pageResult.users) {
      if (!seen.has(u.id)) {
        seen.add(u.id);
        users.push(u);
      }
    }
    pages += 1;
    onProgress(kind, users.length, total);
    if (shouldCancel?.()) throw new Error('cancelled');
    after = pageResult.next;
    if (!after) return users;
    // Every 6th page, take a longer breather to look more human.
    await sleep(pages % 6 === 0 ? randInt(4000, 8000) : randInt(700, 1700));
  }
};
