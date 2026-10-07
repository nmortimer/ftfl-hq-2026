import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAllContracts, saveAllContracts } from './store.js';
import { realContracts } from '../../src/data/realContracts.js';
import { normalize, fetchReserveStatusMap } from '../sync.js';
import type { Contract } from '../../src/lib/contracts';

/**
 * ONE-TIME REPAIR — fixes damage already done by a real bug in sync.ts's
 * taxi/IR reconciliation (now fixed there too, see the comment in that
 * file). The bug: "no reserve-change event found for this player" was
 * being treated as "confirmed not on taxi/IR," silently clearing real
 * designations for players whose taxi/IR status was set before this
 * app's activity-feed tracking ever started (e.g. initial preseason
 * roster construction), which never generates a reserveChange event at
 * all. Confirmed real casualties: Boulder's Cam Ward/Oscar Delp, South
 * Bend's Kyle Williams — all silently kicked off taxi, each one wrongly
 * added back into cap-used totals.
 *
 * This restores, for each currently-live contract matched by id to the
 * original seed (realContracts.ts): any taxiYears/irYears entry the
 * seed had that the live data is now missing — but ONLY for years where
 * fetchReserveStatusMap has NO event at all for that player. If there
 * IS a confirmed event, that's trusted over the seed, exactly like the
 * fixed sync.ts does — this never overrides a real, confirmed move.
 *
 * GET on purpose, same as restore-seed-data.ts and
 * merge-new-seed-contracts.ts — visiting the URL is enough.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const leagueId = process.env.FLEAFLICKER_LEAGUE_ID;
  if (!leagueId) {
    return res.status(400).json({ error: 'FLEAFLICKER_LEAGUE_ID is not set on the server.' });
  }

  try {
    const [live, reserveMap] = await Promise.all([getAllContracts(), fetchReserveStatusMap(leagueId)]);

    const seedById = new Map(realContracts.map((c) => [c.id, c]));
    const restored: string[] = [];

    const updated: Contract[] = live.map((c) => {
      const seed = seedById.get(c.id);
      if (!seed || c.kind === 'buyout' || seed.kind === 'buyout') return c;

      const hasConfirmedEvent = reserveMap.has(normalize(c.playerName));
      if (hasConfirmedEvent) return c; // trust the confirmed event over the seed, same as sync.ts

      const seedTaxi = seed.taxiYears ?? [];
      const seedIR = seed.irYears ?? [];
      const liveTaxi = new Set(c.taxiYears ?? []);
      const liveIR = new Set(c.irYears ?? []);

      let changed = false;
      for (const y of seedTaxi) {
        if (!liveTaxi.has(y)) {
          liveTaxi.add(y);
          changed = true;
        }
      }
      for (const y of seedIR) {
        if (!liveIR.has(y)) {
          liveIR.add(y);
          changed = true;
        }
      }

      if (!changed) return c;
      restored.push(`${c.playerName} (${c.team})`);
      return { ...c, taxiYears: Array.from(liveTaxi), irYears: Array.from(liveIR) };
    });

    if (restored.length === 0) {
      return res.status(200).json({ ok: true, restored: 0, message: 'Nothing to restore — no contract is missing a seed taxi/IR year that lacks a confirmed reserve event.' });
    }

    await saveAllContracts(updated);
    return res.status(200).json({
      ok: true,
      restored: restored.length,
      restoredPlayers: restored,
      message: `Restored taxi/IR status for ${restored.length} player(s). Everything else was left untouched.`,
    });
  } catch (err: any) {
    return res.status(500).json({ error: `Repair failed: ${err?.message}` });
  }
}
