import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getJSON } from './_lib/store.js';
import type { LeagueHistory } from '../src/lib/leagueHistory';

const HISTORY_KEY = 'ftfl:league-history';

// Read-only — just serves whatever compute-league-history.ts last cached.
// Never computes anything itself, so it's cheap to call on every team
// page load. Returns null if history hasn't been computed yet at all.
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const history = await getJSON<LeagueHistory>(HISTORY_KEY);
  return res.status(200).json({ history });
}
