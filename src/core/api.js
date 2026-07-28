// Instagram API — one client for all three tools.
import { HOST, IG_APP_ID, PAGE_SIZE, POST_PAGE, HASH, EDGE, RATE_LIMIT_RE } from './constants.js';
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
    // Instagram sometimes serves a server-side failure as HTTP 200 with
    // `{status:'fail', message}` — surface its message instead of letting the
    // caller invent a "not found" from the missing payload.
    if (!response.ok || body?.status === 'fail') throw new ApiError(body?.message || `HTTP ${response.status}`, response.ok ? 500 : response.status);
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
  // Profile info + last 3 posts (web_profile_info), with a search-based fallback.
  async getWebProfile(username) {
    try {
      return await this._webProfile(username);
    } catch (err) {
      if (err instanceof RateLimit) throw err;
      return this._profileFallback(username, err);
    }
  },
  async _webProfile(username) {
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
  // Same shape from `users/<pk>/info/`, which speaks the api/v1 dialect and
  // carries no thumbnails.
  _mapUserInfo(user) {
    return {
      id: String(user.pk ?? user.pk_id ?? user.id ?? ''),
      username: user.username,
      fullName: user.full_name || '',
      picUrl: user.profile_pic_url || '',
      picUrlHd: user.hd_profile_pic_url_info?.url || user.profile_pic_url || '',
      isPrivate: !!user.is_private,
      isVerified: !!user.is_verified,
      followerCount: user.follower_count ?? 0,
      followingCount: user.following_count ?? 0,
      mutualCount: user.mutual_followers_count ?? 0,
      postsCount: user.media_count ?? 0,
      followedByViewer: user.friendship_status?.following ?? null,
      requestedByViewer: user.friendship_status?.outgoing_request ?? null,
      posts: [],
    };
  },
  // web_profile_info fails outright on some business accounts — Instagram's own
  // serializer 500s on a schema field Meta deleted ("Asset
  // asset://laser.provider/ig_business_category_subvertical has been deleted").
  // Search runs off a different backend, so it still resolves the id; then
  // users/<pk>/info/ fills in the counts. If the account really doesn't exist,
  // the original error is the honest one to report.
  async _profileFallback(username, cause) {
    const wanted = username.toLowerCase();
    const search = await this.request(`https://${HOST}/web/search/topsearch/?context=blended&query=${encodeURIComponent(username)}`);
    const hit = (search?.users || []).map((entry) => entry.user).find((u) => u?.username?.toLowerCase() === wanted);
    if (!hit) throw cause;
    const body = await this.request(`https://${HOST}/api/v1/users/${hit.pk}/info/`);
    if (!body?.user) throw cause;
    return this._mapUserInfo({ ...hit, ...body.user });
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

  // ── posts (timeline media) ──
  // Normalise one api/v1 feed item. `likes: null` means "hidden by the owner" —
  // distinct from 0, so it renders as — and stays out of averages / sorts.
  _mapMedia(item) {
    const image = item.image_versions2 || item.carousel_media?.[0]?.image_versions2;
    const likeCount = item.like_count;
    const productType = item.product_type || '';
    let type = 'photo';
    if (item.media_type === 8) type = 'carousel';
    else if (productType === 'clips') type = 'reel';
    else if (item.media_type === 2) type = 'video';
    return {
      id: String(item.pk ?? item.id),
      shortcode: item.code || '',
      thumb: image?.candidates?.at(-1)?.url || '',
      likes: item.like_and_view_counts_disabled || !(likeCount >= 0) ? null : likeCount,
      comments: item.comment_count ?? 0,
      // play_count is IG + FB combined; ig_play_count is the Instagram-only slice.
      views: item.play_count ?? item.ig_play_count ?? item.view_count ?? null,
      // The Reels repost counter — the closest thing to a public "shares" number.
      // Absent on most posts (DM sends and story shares are never exposed).
      reposts: item.media_repost_count ?? 0,
      ts: (item.taken_at || 0) * 1000,
      type,
      caption: item.caption?.text || '',
      location: item.location?.name || '',
      tagged: item.usertags?.in?.length ?? 0,
      pinned: !!item.timeline_pinned_user_ids?.length,
      commentsDisabled: !!(item.comments_disabled || item.disable_caption_and_comment),
      slides: item.carousel_media_count ?? 0,
      duration: item.video_duration ?? null,
    };
  },
  // Same shape from a GraphQL edge_owner_to_timeline_media node (fallback path).
  // It carries no pinned flag and no product_type, so reels read as plain video.
  _mapMediaGraph(node) {
    const likeCount = node.edge_liked_by?.count ?? node.edge_media_preview_like?.count;
    const slides = node.edge_sidecar_to_children?.edges?.length ?? 0;
    return {
      id: String(node.id),
      shortcode: node.shortcode || '',
      thumb: node.thumbnail_src || node.display_url || '',
      likes: likeCount >= 0 ? likeCount : null,
      comments: node.edge_media_to_comment?.count ?? 0,
      views: node.video_view_count ?? null,
      reposts: 0,
      ts: (node.taken_at_timestamp || 0) * 1000,
      type: slides ? 'carousel' : (node.is_video ? 'video' : 'photo'),
      caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
      location: node.location?.name || '',
      tagged: node.edge_media_to_tagged_user?.edges?.length ?? 0,
      pinned: false,
      commentsDisabled: !!node.comments_disabled,
      slides,
      duration: node.video_duration ?? null,
    };
  },
  // One page of a user's own timeline. api/v1 primary, GraphQL fallback.
  async mediaPage(userId, after) {
    try {
      const maxId = after ? `&max_id=${encodeURIComponent(after)}` : '';
      const body = await this.request(`https://${HOST}/api/v1/feed/user/${userId}/?count=${POST_PAGE}${maxId}`);
      if (!Array.isArray(body?.items)) throw new ApiError('bad feed payload', 0);
      return {
        posts: body.items.map((item) => this._mapMedia(item)),
        next: body.more_available ? body.next_max_id : null,
        total: body.total_count ?? null,
      };
    } catch (err) {
      if (err instanceof RateLimit) throw err;
      const vars = { id: String(userId), first: 12 };
      if (after) vars.after = after;
      const body = await this.request(`https://${HOST}/graphql/query/?query_hash=${HASH.media}&variables=${encodeURIComponent(JSON.stringify(vars))}`);
      const connection = body?.data?.user?.edge_owner_to_timeline_media;
      if (!connection) throw new ApiError('bad graphql media payload', 0);
      return {
        posts: (connection.edges || []).map((edge) => this._mapMediaGraph(edge.node)),
        next: connection.page_info?.has_next_page ? connection.page_info.end_cursor : null,
        total: connection.count ?? null,
      };
    }
  },
};

// Paginate a whole list (followers|following) of `userId` with human pacing.
// shouldCancel() aborts and discards; shouldStop() returns the partial list.
export const scanList = async (kind, onProgress, userId, shouldCancel, shouldStop) => {
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
    if (shouldStop?.()) return users;
    after = pageResult.next;
    if (!after) return users;
    // Every 6th page, take a longer breather to look more human.
    await sleep(pages % 6 === 0 ? randInt(4000, 8000) : randInt(700, 1700));
  }
};

// Paginate a user's timeline, same pacing/cancel contract as scanList.
// `max` caps the haul (Infinity for "everything") — a 3k-post account is ~90
// requests, so the caller offers a ceiling instead of committing to all of it.
export const scanPosts = async (userId, onProgress, max, shouldCancel, shouldStop) => {
  const posts = [];
  const seen = new Set();
  let after = null;
  let total = null;
  let pages = 0;
  for (;;) {
    const pageResult = await api.mediaPage(userId, after);
    if (pageResult.total != null) total = pageResult.total;
    for (const p of pageResult.posts) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        posts.push(p);
      }
    }
    pages += 1;
    onProgress(posts.length, total);
    if (shouldCancel?.()) throw new Error('cancelled');
    if (shouldStop?.()) return posts;
    after = pageResult.next;
    if (!after || posts.length >= max) return posts;
    await sleep(pages % 6 === 0 ? randInt(4000, 8000) : randInt(700, 1700));
  }
};
