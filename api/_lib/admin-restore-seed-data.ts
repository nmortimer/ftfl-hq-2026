import type { VercelRequest, VercelResponse } from '@vercel/node';
import { saveAllContracts } from './store.js';
import { realContracts } from '../../src/data/realContracts.js';

// Emergency-only: wipes whatever's in Redis and replaces it with the
// original imported spreadsheet data. Use this if something (like a bad
// sync) corrupts live data. GET on purpose, so it can be triggered by
// just visiting the URL in a browser — no curl, no POST body needed —
// since the whole point is being usable in a panic.
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await saveAllContracts(realContracts);
    return res.status(200).json({
      ok: true,
      message: `Restored ${realContracts.length} contracts from the original spreadsheet import.`,
    });
  } catch (err: any) {
    return res.status(500).json({ error: `Restore failed: ${err?.message}` });
  }
}
