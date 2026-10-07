import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAllContracts } from './_lib/store.js';
import { fetchRosterMap, fetchReserveStatusMap, isActiveThisYear, normalize } from './sync.js';

/**
 * READ-ONLY team-by-team check: Fleaflicker rosters (FetchLeagueRosters,
 * the same confirmed source Sync uses) vs. contracts on file. Changes
 * nothing — every fix is a separate, explicit commissioner action on FA
 * review.
 *
 * - unsigned:    on a Fleaflicker roster, no active contract anywhere
 *                → needs a "Won for $" 1-year contract
 * - mismatches:  on team A's Fleaflicker roster, contract on file for team B
 *                → either a trade (move contract) or a drop + pickup
 *                  (buy out B, new 1-year deal for A)
 * - notOnRoster: active contract on file, not on any Fleaflicker roster
 *                → cut candidate (confirmed via Sync, as before)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const leagueId = process.env.FLEAFLICKER_LEAGUE_ID;
  if (!leagueId) return res.status(400).json({ error: 'FLEAFLICKER_LEAGUE_ID is not set on the server.' });
  const year = Number(req.query.year) || new Date().getFullYear();

  let rosterMap;
  try {
    rosterMap = (await fetchRosterMap(leagueId, year)).map;
  } catch (err: any) {
    return res.status(502).json({ error: `Failed to reach Fleaflicker: ${err?.message}` });
  }
  // Same safety guard as Sync: a near-empty map means a parsing mismatch,
  // and would otherwise report every contract as "not on roster".
  if (rosterMap.size < 20) {
    return res.status(502).json({ error: `Only ${rosterMap.size} rostered players recognized — likely a parsing mismatch, check skipped.` });
  }

  // Taxi/IR tags for unsigned players, from the same confirmed
  // reserveChange feed Sync uses. Best-effort: if it fails, the check
  // still runs, just without the taxi/IR defaults.
  let reserveMap = new Map<string, { isTaxi: boolean; isIR: boolean }>();
  try {
    reserveMap = await fetchReserveStatusMap(leagueId);
  } catch {}

  const contracts = (await getAllContracts()).filter((c) => c.kind !== 'buyout' && isActiveThisYear(c, year));
  const byName = new Map(contracts.map((c) => [normalize(c.playerName), c]));

  const unsigned: { playerName: string; team: string; position?: string; isTaxi?: boolean; isIR?: boolean }[] = [];
  const mismatches: { contractId: string; playerName: string; sheetTeam: string; fleaflickerTeam: string }[] = [];
  for (const [key, info] of rosterMap) {
    const c = byName.get(key);
    if (!c) {
      const r = reserveMap.get(key);
      unsigned.push({ playerName: info.playerName, team: info.teamSlug, position: info.position, isTaxi: r?.isTaxi, isIR: r?.isIR });
    }
    else if (c.team !== info.teamSlug)
      mismatches.push({ contractId: c.id, playerName: c.playerName, sheetTeam: c.team, fleaflickerTeam: info.teamSlug });
  }
  const notOnRoster = contracts
    .filter((c) => !rosterMap.has(normalize(c.playerName)))
    .map((c) => ({ contractId: c.id, playerName: c.playerName, sheetTeam: c.team }));

  // Contracts with a blank/invalid position, where Fleaflicker has one
  // for that rostered player — offered as a one-click fill.
  const VALID = ['QB', 'RB', 'WR', 'TE'];
  const missingPositions = contracts
    .filter((c) => !VALID.includes(c.position))
    .map((c) => ({ c, pos: rosterMap.get(normalize(c.playerName))?.position }))
    .filter((x): x is { c: typeof x.c; pos: string } => Boolean(x.pos && VALID.includes(x.pos)))
    .map(({ c, pos }) => ({ contractId: c.id, playerName: c.playerName, position: pos }));

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ year, unsigned, mismatches, notOnRoster, missingPositions });
}
