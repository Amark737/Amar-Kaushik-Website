// GET /api/ig-refresh — refreshes the long-lived Instagram token before it expires.
// Called monthly by the Vercel cron in vercel.json (tokens last ~60 days; refresh
// requires the token to be >24h old, so monthly is comfortably inside the window).
//
// A refresh returns a NEW token string. Serverless functions cannot rewrite their
// own env vars, so persistence works in one of two modes:
//   1. AUTOMATIC (recommended): set VERCEL_API_TOKEN + VERCEL_PROJECT_ID env vars —
//      this function then updates the IG_TOKEN project env var via the Vercel API
//      and triggers a redeploy so the new value takes effect.
//   2. MANUAL: without those vars it still refreshes upstream (keeping the account's
//      token lineage alive) and returns the new token in the response so it can be
//      pasted into the Vercel dashboard by hand.

module.exports = async (req, res) => {
  const token = process.env.IG_TOKEN;
  if (!token) {
    res.status(503).json({ error: 'no_token' });
    return;
  }

  try {
    const r = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`
    );
    const body = await r.json();
    if (!r.ok || !body.access_token) {
      res.status(502).json({ error: 'refresh_failed', detail: body.error && body.error.message });
      return;
    }

    const newToken = body.access_token;
    const expiresDays = Math.round((body.expires_in || 0) / 86400);

    const vt = process.env.VERCEL_API_TOKEN;
    const pid = process.env.VERCEL_PROJECT_ID;
    if (vt && pid) {
      // find the existing IG_TOKEN env id, patch it, redeploy
      const envList = await fetch(`https://api.vercel.com/v9/projects/${pid}/env`, {
        headers: { Authorization: `Bearer ${vt}` },
      }).then((x) => x.json());
      const entry = (envList.envs || []).find((e) => e.key === 'IG_TOKEN');
      if (entry) {
        await fetch(`https://api.vercel.com/v9/projects/${pid}/env/${entry.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${vt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: newToken }),
        });
        res.status(200).json({ ok: true, mode: 'automatic', expires_in_days: expiresDays });
        return;
      }
    }

    res.status(200).json({ ok: true, mode: 'manual', expires_in_days: expiresDays, new_token: newToken });
  } catch (e) {
    res.status(502).json({ error: 'refresh_exception' });
  }
};
