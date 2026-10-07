import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAllContracts, saveAllContracts } from './store.js';
import { realContracts } from '../../src/data/realContracts.js';

/**
 * SAFE, additive-only — unlike restore-seed-data.ts (which wipes and
 * replaces everything), this only ADDS whatever's in the bundled
 * realContracts.ts but missing from live Redis data, matched by id.
 * Everything already in Redis (synced trades, confirmed cuts/buyouts,
 * manual edits) is left completely untouched.
 *
 * Built for exactly this situation: new rows get added to
 * realContracts.ts in code (like the 14 pre-existing buyout entries,
 * ids 234-247) AFTER the app has already started using Redis as its
 * source of truth, so just deploying the new code doesn't make them
 * appear — Redis's existing full contract list overrides the bundled
 * file on every load. This merges the gap in one safe step.
 *
 * GET on purpose, so it's triggerable by just visiting the URL, same
 * as restore-seed-data.ts.
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const current = await getAllContracts();
    const currentIds = new Set(current.map((c) => c.id));
    const missing = realContracts.filter((c) => !currentIds.has(c.id));

    if (missing.length === 0) {
      return res.status(200).json({
        ok: true,
        added: 0,
        message: 'Nothing to merge — every contract id in realContracts.ts already exists in the live data.',
      });
    }

    const merged = [...current, ...missing];
    await saveAllContracts(merged);
    return res.status(200).json({
      ok: true,
      added: missing.length,
      addedPlayers: missing.map((c) => `${c.playerName} (${c.team}, ${c.kind})`),
      message: `Added ${missing.length} new contract(s) from realContracts.ts. Everything already in the live data was left untouched.`,
    });
  } catch (err: any) {
    return res.status(500).json({ error: `Merge failed: ${err?.message}` });
  }
}
