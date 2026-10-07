import type { VercelRequest, VercelResponse } from '@vercel/node';

// Fleaflicker's API has no CORS headers, so the browser can't call it
// directly — this proxies the request server-side instead. It's a public,
// read-only API for public leagues; no API key or login involved.
//
// Only these two endpoints are allowed through, to keep this from being an
// open proxy to arbitrary URLs.
const ALLOWED_ENDPOINTS = new Set(['FetchLeagueStandings', 'FetchLeagueScoreboard', 'FetchLeagueTransactions']);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const leagueId = process.env.FLEAFLICKER_LEAGUE_ID;
  if (!leagueId) {
    return res.status(400).json({
      error: 'FLEAFLICKER_LEAGUE_ID is not set on the server. Find it in your league\'s Fleaflicker URL (fleaflicker.com/nfl/leagues/<this number>) and add it as an env var.',
    });
  }

  const endpoint = String(req.query.endpoint || '');
  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return res.status(400).json({ error: `Unknown or unsupported endpoint: ${endpoint}` });
  }

  const season = String(req.query.season || new Date().getFullYear());
  const week = req.query.week ? String(req.query.week) : null;

  const url = new URL(`https://www.fleaflicker.com/api/${endpoint}`);
  url.searchParams.set('sport', 'NFL');
  url.searchParams.set('league_id', leagueId);
  // Only attach season/week where they're actually meaningful — Nick's
  // own successful manual test of FetchLeagueTransactions had NO season
  // param at all, and this proxy was silently adding one to every
  // request regardless of endpoint. Left untested, exactly the same
  // mistake as the FetchRoster `season` param that broke things earlier
  // in this project.
  if (endpoint !== 'FetchLeagueTransactions') {
    url.searchParams.set('season', season);
    if (week) url.searchParams.set('scoring_period', week);
  }

  try {
    const upstream = await fetch(url.toString());
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Fleaflicker returned ${upstream.status}` });
    }
    const data = await upstream.json();
    // Transactions need to reflect adds/drops within seconds, not
    // minutes — no caching for that endpoint. Standings/scoreboard
    // change far less often, so a brief edge cache there is still fine.
    if (endpoint === 'FetchLeagueTransactions') {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    }
    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(502).json({ error: `Failed to reach Fleaflicker: ${err?.message}` });
  }
}
