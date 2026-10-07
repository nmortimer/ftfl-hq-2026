import type { Contract } from './contracts';
import type { LeagueHistory } from './leagueHistory';

/**
 * Fetches live contracts from the backend. Returns null (not a throw) on
 * any failure — no deployed API, no KV configured, offline, whatever —
 * so callers can fall back to the bundled seed data without special-casing
 * every possible failure mode.
 */
export async function fetchContracts(): Promise<Contract[] | null> {
  try {
    const res = await fetch('/api/contracts');
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.contracts) ? data.contracts : null;
  } catch {
    return null;
  }
}

/**
 * Login/password checking is DISABLED for now — commissioner tools are
 * open to anyone with the link. See README for how to re-enable
 * COMMISSIONER_PASSWORD checking on the server side later.
 */
export async function saveContracts(contracts: Contract[]): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/contracts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contracts }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.error || `Save failed (${res.status})` };
  } catch {
    return { ok: false, error: 'Could not reach the server' };
  }
}

export interface FleaflickerTeamRecord {
  name: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
}

/**
 * Live standings from Fleaflicker, matched to our team slugs by name.
 * Returns null on any failure (not configured, league not found, offline)
 * so the League Summary can just show a dash instead of crashing.
 *
 * Field names (recordOverall, pointsFor, etc.) are camelCase, confirmed
 * against a real response from this league — Fleaflicker's own docs show
 * these as snake_case (record_overall) because that's the underlying
 * proto field name, but the actual JSON over the wire auto-converts to
 * camelCase. This tripped up the first version of this function.
 */
export async function fetchFleaflickerStandings(season: number): Promise<FleaflickerTeamRecord[] | null> {
  try {
    const res = await fetch(`/api/fleaflicker?endpoint=FetchLeagueStandings&season=${season}`);
    if (!res.ok) return null;
    const data = await res.json();
    const divisions = data?.divisions ?? [];
    const teams: FleaflickerTeamRecord[] = [];
    for (const division of divisions) {
      for (const entry of division.teams ?? []) {
        teams.push({
          name: entry.name ?? '',
          wins: entry.recordOverall?.wins ?? 0,
          losses: entry.recordOverall?.losses ?? 0,
          ties: entry.recordOverall?.ties ?? 0,
          pointsFor: entry.pointsFor?.value ?? 0,
        });
      }
    }
    return teams;
  } catch {
    return null;
  }
}

export interface FleaflickerActivityItem {
  raw: unknown;
  timeEpochMilli: number;
  kind: 'drop' | 'transaction' | 'unknown';
  description: string;
  teamName?: string;
  playerName?: string;
  position?: string;
  isTaxi?: boolean;
  isIR?: boolean;
  transactionType?: string;
}

/**
 * Confirmed against a real transaction-log response from this league (not
 * guessed). Key findings that differ from what the docs alone showed:
 * - Fields are camelCase (timeEpochMilli, proPlayer, nameFull) — see the
 *   note on fetchFleaflickerStandings for why.
 * - `team` is a sibling of `transaction` on the item itself, not nested
 *   inside it.
 * - Confirmed real type value: "TRANSACTION_DROP" for a cut/drop.
 * - REAL ADD EVENTS NEVER GET A `type` FIELD AT ALL. Confirmed directly:
 *   recent adds (a player picked up minutes apart, landing on a real
 *   team) show up with no `transaction.type` key whatsoever — but they
 *   DO have `transaction.owner` (the team that now has them). Drops are
 *   the mirror image: they have `type: "TRANSACTION_DROP"` but no
 *   `owner` at all, since the player is now a free agent. That
 *   presence/absence of `owner` is the reliable signal for "this is
 *   worth reviewing as a transaction" — not the `type` field, which an
 *   earlier version of this code required and which real adds simply
 *   don't have. (The `findContract` check downstream still protects
 *   against flooding the FA list with long-since-contracted players who
 *   also show up here without a `type` — anyone already under contract
 *   gets filtered out there regardless of this classification.)
 * - No bid/waiver-cost field appears anywhere — matches what Nick said:
 *   this league prices free agents outside Fleaflicker entirely.
 */
function parseActivityItem(item: any): FleaflickerActivityItem {
  const timeEpochMilli = Number(item?.timeEpochMilli ?? 0);
  const t = item?.transaction;
  // Real paste (Summit County item, tail of the feed) shows the shape is
  // transaction: { player: { proPlayer, owner, ... }, team } — `owner`
  // sits on the player object, and `team` sits inside `transaction`, not
  // on the item. Earlier code read t.owner and item.team, neither of
  // which exists there, so hasOwner was always false and every add fell
  // into "unknown" even after the owner-based fix. Old paths kept as
  // fallbacks in case some item types really do use them.
  const ownerObj = t?.player?.owner ?? t?.owner;
  const teamName = t?.team?.name ?? item?.team?.name ?? ownerObj?.name ?? undefined;
  const playerName = t?.player?.proPlayer?.nameFull ?? undefined;
  // Confirmed in the real paste: proPlayer.position (e.g. "WR" for Vele).
  const position = t?.player?.proPlayer?.position ?? undefined;
  const transactionType = t?.type ?? undefined;
  const hasOwner = Boolean(ownerObj?.id);

  if (playerName && transactionType === 'TRANSACTION_DROP') {
    return {
      raw: item,
      timeEpochMilli,
      kind: 'drop',
      teamName,
      playerName,
      transactionType,
      description: `Dropped: ${playerName}${teamName ? ` — ${teamName}` : ''}`,
    };
  }

  if (playerName && (transactionType || hasOwner)) {
    return {
      raw: item,
      timeEpochMilli,
      kind: 'transaction',
      teamName,
      playerName,
      position,
      transactionType,
      description: transactionType
        ? `${transactionType}: ${playerName}${teamName ? ` — ${teamName}` : ''}`
        : `Added: ${playerName}${teamName ? ` — ${teamName}` : ''}`,
    };
  }

  return {
    raw: item,
    timeEpochMilli,
    kind: 'unknown',
    teamName,
    playerName,
    description: playerName
      ? `${playerName} — roster/trade-block info (not a confirmed transaction)${teamName ? `, ${teamName}` : ''}`
      : 'Unrecognized activity',
  };
}

export async function fetchFleaflickerActivity(): Promise<FleaflickerActivityItem[] | null> {
  try {
    const res = await fetch('/api/fleaflicker?endpoint=FetchLeagueTransactions');
    if (!res.ok) return null;
    const data = await res.json();
    const items = data?.items ?? [];
    return items.map(parseActivityItem);
  } catch {
    return null;
  }
}

export interface ProposedCut {
  id: string;
  playerName: string;
  team: string;
}

export interface SyncSummary {
  trades: { name: string; from: string; to: string }[];
  taxiChanges: string[];
  irChanges: string[];
  proposedCuts: ProposedCut[];
}

/**
 * Runs the server-side reconciliation against Fleaflicker's current
 * rosters (per-team FetchRoster, confirmed against a real response —
 * see api/sync.ts). Trades and taxi/IR are applied and saved
 * automatically now that the underlying fields are confirmed, not
 * guessed. Cuts are still NOT applied automatically — "not found on any
 * roster" has caused real failures before from unrelated causes, so
 * cuts only ever come back as proposals for the commissioner to confirm
 * individually, regardless of how reliable the rest of this has proven.
 */
export async function syncFromFleaflicker(year: number): Promise<{ ok: boolean; summary?: SyncSummary; error?: string }> {
  try {
    const res = await fetch(`/api/sync?year=${year}`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || `Sync failed (${res.status})` };
    return { ok: true, summary: body.summary };
  } catch {
    return { ok: false, error: 'Could not reach the server' };
  }
}

/**
 * Reads whatever league history is currently cached in Redis — never
 * computes anything itself (see api/compute-league-history.ts for the
 * heavy one-time job that actually builds this). Returns null if
 * history hasn't been computed yet at all, which the UI treats as
 * "nothing to show" rather than an error.
 */
export async function fetchLeagueHistory(): Promise<LeagueHistory | null> {
  try {
    const res = await fetch('/api/league-history');
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    return body.history ?? null;
  } catch {
    return null;
  }
}

export interface TopScorer {
  position: string;
  playerName: string;
  totalPoints: number;
}

export interface TeamTopScorers {
  teamSlug: string;
  scorers: TopScorer[];
}

export interface TopScorersResult {
  computedAtEpochMilli: number;
  seasonsCovered: { from: number; to: number };
  teams: TeamTopScorers[];
}

/**
 * Reads whatever top-scorer data is currently cached in Redis — never
 * computes anything itself (see api/compute-top-scorers.ts for the very
 * heavy one-time job that builds this, ~700+ requests across every
 * season's boxscores). Returns null if it hasn't been computed yet.
 */
export async function fetchTopScorers(): Promise<TopScorersResult | null> {
  try {
    const res = await fetch('/api/top-scorers');
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    return body.result ?? null;
  } catch {
    return null;
  }
}

export interface RosterCheck {
  year: number;
  unsigned: { playerName: string; team: string; position?: string; isTaxi?: boolean; isIR?: boolean }[];
  mismatches: { contractId: string; playerName: string; sheetTeam: string; fleaflickerTeam: string }[];
  notOnRoster: { contractId: string; playerName: string; sheetTeam: string }[];
  missingPositions?: { contractId: string; playerName: string; position: string }[];
}

/** Read-only roster-vs-contracts check (api/roster-check.ts). */
export async function fetchRosterCheck(year: number): Promise<{ ok: boolean; data?: RosterCheck; error?: string }> {
  try {
    const res = await fetch(`/api/roster-check?year=${year}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || `Roster check failed (${res.status})` };
    return { ok: true, data: body };
  } catch {
    return { ok: false, error: 'Could not reach the server' };
  }
}

export type Rec3 = { wins: number; losses: number; ties: number };
export interface PowerRow {
  teamSlug: string;
  powerScore: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  allPlay: { wins: number; losses: number };
  last5: Rec3;
  fp: {
    dynasty: number;
    ros: number;
    rosStarters: string[];
    dynastyStarters: string[];
    dynastyTop: [number, number, number];
    rosTop: [number, number, number];
    matched: number;
  } | null;
  componentRanks: Record<string, number>;
}
export interface PowerRankings {
  computedAtEpochMilli: number;
  season: number;
  completedWeeks: number;
  weeksCounted: number[];
  last5Active: boolean;
  activeComponents: string[];
  rows: PowerRow[];
  matrix: Record<string, Record<string, Rec3>>;
  fp: { ok: boolean; error?: string; warning?: string; playerCounts?: { dynasty: number; ros: number } };
}

/** api/power-rankings.ts — cached 3h server-side; refresh forces a rebuild. */
export async function fetchPowerRankings(year: number, refresh = false): Promise<{ ok: boolean; data?: PowerRankings; error?: string }> {
  try {
    const res = await fetch(`/api/power-rankings?year=${year}${refresh ? '&refresh=1' : ''}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || `Power rankings failed (${res.status})` };
    return { ok: true, data: body };
  } catch {
    return { ok: false, error: 'Could not reach the server' };
  }
}
