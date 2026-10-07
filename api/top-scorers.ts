import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getJSON } from './_lib/store.js';
import type { TopScorersResult } from './compute-top-scorers.js';

const TOP_SCORERS_KEY = 'ftfl:top-scorers';

// Read-only — just serves whatever compute-top-scorers.ts last cached.
// Never computes anything itself, cheap to call on every team page load.
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const result = await getJSON<TopScorersResult>(TOP_SCORERS_KEY);
  return res.status(200).json({ result });
}
