// GET /api/instagram — proxies the Instagram Graph API (Instagram Login flavour).
// Token comes from the IG_TOKEN env var (long-lived, ~60 days, refreshed by /api/ig-refresh).
//
// Mirrors the PROFILE GRID as it actually looks, not the raw upload stream:
//   - reels kept off the grid (is_shared_to_feed === false) are dropped
//   - pinned posts (PINNED_IDS below) are surfaced first, in pin order
// The Graph API does not expose pin status, so PINNED_IDS mirrors the profile by
// hand — update it when the pins change. Find IDs via /api/instagram?debug=1
// (walk older pages with &after=<cursor> from the debug response's paging field).
//
// Response is CDN-cached for 30 minutes so Instagram is hit rarely regardless of traffic.

const FIELDS =
  'id,caption,media_type,media_product_type,is_shared_to_feed,media_url,thumbnail_url,permalink,timestamp';
// fallback if this token/API flavour rejects the extended fields
const BASE_FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';

const PINNED_IDS = []; // media IDs pinned on the profile, in pin order

// Collab posts authored by other accounts never come back from /me/media — the
// platform offers no API for them. CURATED mirrors those grid tiles by hand:
// host the cover in site/assets/ig/ and list the entry here. pinned:true entries
// lead the feed; the rest interleave with live posts by timestamp.
// { link:'https://www.instagram.com/reel/SHORTCODE/', src:'/assets/ig/cover.jpg',
//   caption:'…', ts:'2026-07-01T00:00:00+0000', type:'VIDEO', pinned:true }
const CURATED = [];

const GRAPH = 'https://graph.instagram.com';

module.exports = async (req, res) => {
  const token = process.env.IG_TOKEN;
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!token) {
    res.status(503).json({ error: 'feed_not_configured' });
    return;
  }

  const q = req.query || {};

  const get = async (path, fields, extra) => {
    const url =
      `${GRAPH}${path}?fields=${fields}&access_token=${encodeURIComponent(token)}` +
      (extra || '');
    const r = await fetch(url);
    return { ok: r.ok, body: await r.json() };
  };

  // try the extended field set; drop to the base set if the API rejects a field
  const getMedia = async (path, extra) => {
    let out = await get(path, FIELDS, extra);
    if (!out.ok && out.body && out.body.error && /field/i.test(out.body.error.message || '')) {
      out = await get(path, BASE_FIELDS, extra);
    }
    return out;
  };

  try {
    // pagination cursor is a debug-only affordance — honoring it on the public
    // path would let arbitrary query strings bypass the CDN cache and burn the
    // Instagram rate limit
    const after =
      'debug' in q && typeof q.after === 'string' ? `&after=${encodeURIComponent(q.after)}` : '';

    // debug-only probe of the tagged-media edge (collab posts live on other accounts)
    if ('debug' in q && q.edge === 'tags') {
      let out = await get('/me/tags', 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,username', `&limit=50${after}`);
      if (!out.ok) out = await get('/me/tags', 'id,caption,media_type,permalink,timestamp,username', `&limit=50${after}`);
      res.setHeader('Cache-Control', 'no-store');
      res.status(out.ok ? 200 : 502).json({
        next: out.body.paging && out.body.paging.cursors && out.body.paging.cursors.after,
        error: out.body.error && out.body.error.message,
        items: (out.body.data || []).map((p) => ({
          id: p.id,
          user: p.username,
          type: p.media_type,
          has_src: !!(p.media_url || p.thumbnail_url),
          ts: (p.timestamp || '').slice(0, 10),
          cap: (p.caption || '').split('\n')[0].slice(0, 40),
        })),
      });
      return;
    }

    const { ok, body } = await getMedia('/me/media', `&limit=50${after}`);

    if (!ok || body.error) {
      res.setHeader('Cache-Control', 's-maxage=300');
      res.status(502).json({ error: 'instagram_error', detail: body.error && body.error.message });
      return;
    }

    const all = body.data || [];

    if ('debug' in q) {
      // token-free inspection view (public post metadata only, no media URLs)
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        counts: {
          fetched: all.length,
          hidden_from_grid: all.filter((p) => p.is_shared_to_feed === false).length,
        },
        next: body.paging && body.paging.cursors && body.paging.cursors.after,
        items: all.map((p) => ({
          id: p.id,
          type: p.media_type,
          product: p.media_product_type,
          shared: p.is_shared_to_feed,
          ts: (p.timestamp || '').slice(0, 10),
          cap: (p.caption || '').split('\n')[0].slice(0, 40),
        })),
      });
      return;
    }

    // the grid as the profile shows it: everything except reels hidden from it
    const grid = all.filter((p) => p.is_shared_to_feed !== false);

    // IG media IDs exceed Number.MAX_SAFE_INTEGER — normalize so a numerically
    // pasted config entry still matches the API's string ids
    const pinIds = PINNED_IDS.map(String);

    // pinned posts first — pull any pinned post too old for this page directly by ID
    const pinned = [];
    for (const id of pinIds) {
      const inPage = grid.find((p) => p.id === id);
      if (inPage) {
        pinned.push(inPage);
      } else {
        const one = await getMedia(`/${id}`, '');
        if (one.ok && one.body && !one.body.error && one.body.id) pinned.push(one.body);
      }
    }

    const norm = (u) => String(u || '').replace(/\/+$/, '');
    const curated = CURATED.map((c, i) => ({ id: 'curated-' + i, ...c, pinned: !!c.pinned }));
    const curatedLinks = new Set(curated.map((c) => norm(c.link)));

    // live copies of hand-curated posts would render twice — curated entry wins
    const rest = grid.filter(
      (p) => !pinIds.includes(p.id) && !curatedLinks.has(norm(p.permalink))
    );

    const shape = (p) => ({
      id: p.id,
      type: p.media_type, // IMAGE | VIDEO | CAROUSEL_ALBUM
      // no media_url fallback for videos: it is an .mp4, useless in an <img>
      src: p.media_type === 'VIDEO' ? p.thumbnail_url : (p.media_url || p.thumbnail_url),
      caption: (p.caption || '').split('\n')[0].slice(0, 120),
      link: p.permalink,
      ts: p.timestamp,
      pinned: pinIds.includes(p.id),
    });

    const lead = curated.filter((c) => c.pinned).concat(pinned.map(shape));
    const body_ = curated
      .filter((c) => !c.pinned)
      .concat(rest.map(shape))
      .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));

    // copyright-muted or mid-processing media can arrive with no usable image —
    // drop those rather than shipping a broken tile
    const usable = (p) => p.src && !/\.mp4$/i.test(String(p.src).split('?')[0]);
    const posts = lead.concat(body_).filter(usable).slice(0, 12);

    // 30 min CDN cache, serve stale for a day while revalidating
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    res.status(200).json({ posts });
  } catch (e) {
    res.setHeader('Cache-Control', 's-maxage=300');
    res.status(502).json({ error: 'fetch_failed' });
  }
};
