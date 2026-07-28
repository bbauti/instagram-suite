// Shared constants: host, IDs, GraphQL query hashes, rate-limit signatures.
export const HOST = 'www.instagram.com';
export const IG_APP_ID = '936619743392459';
export const PAGE_SIZE = 48;
export const ROW_CAP = 600; // cap rendered rows; search still filters the full set
export const POST_PAGE = 33; // page size of the api/v1 user feed
export const POST_CAP_DEFAULT = 300; // default scan ceiling; a 3k-post account takes minutes

// GraphQL query hashes (InstagramUnfollowers / followaccount set)
export const HASH = {
  followers: 'c76146de99bb02f6415203be841dd25a', // edge_followed_by
  following: '3dec7e2c57367ef3da3d987d89f9dbc8', // edge_follow
  highlights: 'd4d88dc1500312af6f937f7b804c68c3', // edge_highlight_reels
  media: 'e769aa130647d2354c40ea6a439bfc08', // edge_owner_to_timeline_media
};
export const EDGE = { followers: 'edge_followed_by', following: 'edge_follow' };

export const RATE_LIMIT_RE = [
  /try again later/i, /wait a few minutes/i, /feedback[_ ]required/i,
  /checkpoint[_ ]required/i, /action blocked/i, /rate[_ ]?limit/i, /\bspam\b/i,
];
