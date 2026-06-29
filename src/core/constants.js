// Shared constants: host, IDs, GraphQL query hashes, rate-limit signatures.
export const HOST = 'www.instagram.com';
export const IG_APP_ID = '936619743392459';
export const PAGE_SIZE = 48;
export const ROW_CAP = 600; // ponytail: cap rendered rows; search still filters the full set

// GraphQL query hashes (InstagramUnfollowers / followaccount set)
export const HASH = {
  followers: 'c76146de99bb02f6415203be841dd25a', // edge_followed_by
  following: '3dec7e2c57367ef3da3d987d89f9dbc8', // edge_follow
  highlights: 'd4d88dc1500312af6f937f7b804c68c3', // edge_highlight_reels
};
export const EDGE = { followers: 'edge_followed_by', following: 'edge_follow' };

export const RATE_LIMIT_RE = [
  /try again later/i, /wait a few minutes/i, /feedback[_ ]required/i,
  /checkpoint[_ ]required/i, /action blocked/i, /rate[_ ]?limit/i, /\bspam\b/i,
];
