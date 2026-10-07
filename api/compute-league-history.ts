import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getJSON, setJSON } from './_lib/store.js';
import { teams } from '../src/data/teams.js';
import type { LeagueHistory, TeamHistory, PostseasonFinish, HeadToHead } from '../src/lib/leagueHistory';

const START_SEASON = 2018; // confirmed: the league's real first season on Fleaflicker
const HISTORY_KEY = 'ftfl:league-history';
// Per-season results, so the weekly cron only re-fetches the current
// season (finished seasons never change). Aggregated into HISTORY_KEY.
const SEASONS_KEY = 'ftfl:league-history-seasons';

/** NFL season year: Jan/Feb games belong to the previous year's season. */
export function currentNflSeason(now = new Date()): number {
  return now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear();
}

type Rec = { wins: number; losses: number; ties: number };
interface SeasonPartial {
  complete: boolean; // championship game found
  totals: Record<number, Rec & { pointsFor: number; pointsAgainst: number }>;
  h2h: Record<number, Record<number, Rec>>;
  postseason: { id: number; finish: PostseasonFinish }[];
  lastPlace: { id: number; season: number; teamNameThatYear: string } | null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Same fix applied here as compute-top-scorers.ts, after that file hit
 * a real 403 from Fleaflicker on a fast back-to-back run (season 2020's
 * discovery call, right after 2018 and 2019 both succeeded) — almost
 * certainly a rate limit, confirmed by manually pacing runs working
 * fine. This file makes the same kind of request volume, just all in
 * one invocation instead of spread across separate calls, so it's
 * exposed to the same risk on any future re-run. Retry 403/429 with a
 * short backoff (1s/2s/4s) before giving up; anything else still fails
 * immediately.
 */
export async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url);
    if (res.ok) return res;
    if ((res.status === 403 || res.status === 429) && i < attempts - 1) {
      await sleep(1000 * Math.pow(2, i));
      continue;
    }
    return res;
  }
  throw new Error('unreachable');
}

/**
 * ONE-TIME (well, "run occasionally") heavy computation — builds full
 * league history (all-time record, head-to-head vs every team,
 * championship/placement history, last-place finishes) from Fleaflicker's
 * own data across every season 2018-present, and caches the result in
 * Redis. The team pages just read the cached result (api/league-history.ts)
 * — this endpoint is only ever run manually, by visiting it (GET), same
 * pattern as the other one-time endpoints in this project.
 *
 * CONFIRMED against a real response before being built: FetchLeagueScoreboard
 * games carry real `isChampionshipGame` / `isThirdPlaceGame` booleans (not
 * inferred) — verified against 2018's actual championship (Grand Rapids
 * Growlers over Standale Stampede) and third-place game (Jenison
 * Juggernauts over Boulder Bandits). Franchise identity is tracked by
 * `fleaflickerId`, never by name — team names change across seasons
 * (Growlers -> Denver Diamondbacks, Juggernauts -> Olde Town Osos, etc.)
 * but the id is permanent, exactly like the rest of this project treats it.
 *
 * "Last place" per season is NOT taken from any consolation-bracket flag
 * (no such field has been confirmed) — it's simply whichever team had the
 * worst regular-season record that year (tiebreak: lowest points for),
 * read directly from standings. Reliable and needs no untested field.
 *
 * Fetches one season at a time (parallel across that season's weeks, but
 * seasons themselves run sequentially) rather than firing every request
 * for every season at once — this is ~150+ external requests in total;
 * capping concurrency to one season's worth at a time is a deliberate
 * safety margin against rate limits and serverless timeouts, at some
 * cost to total wall-clock time. This endpoint can take a while to run.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const leagueId = process.env.FLEAFLICKER_LEAGUE_ID;
  if (!leagueId) {
    return res.status(400).json({ error: 'FLEAFLICKER_LEAGUE_ID is not set on the server.' });
  }

  const throughSeason = Number(req.query.through) || currentNflSeason();
  const seasons: number[] = [];
  for (let y = START_SEASON; y <= throughSeason; y++) seasons.push(y);
  // mode=current (the weekly cron): reuse cached finished seasons, only
  // re-fetch the current season plus any season not cached/complete yet.
  // No mode: full rebuild of every season, same as before.
  const currentOnly = req.query.mode === 'current';

  const knownIds = new Set(teams.map((t) => t.fleaflickerId));

  async function computeSeason(season: number): Promise<SeasonPartial> {
    const p: SeasonPartial = { complete: false, totals: {}, h2h: {}, postseason: [], lastPlace: null };
    const h2hFor = (id: number, opp: number) => {
      p.h2h[id] ??= {};
      return (p.h2h[id][opp] ??= { wins: 0, losses: 0, ties: 0 });
    };

    const standingsRes = await fetchWithRetry(`https://www.fleaflicker.com/api/FetchLeagueStandings?sport=NFL&league_id=${leagueId}&season=${season}`);
    if (!standingsRes.ok) throw new Error(`Standings failed for season ${season} (HTTP ${standingsRes.status})`);
    const standingsData: any = await standingsRes.json();
    const seasonTeams: any[] = (standingsData?.divisions ?? []).flatMap((d: any) => d?.teams ?? []);
    const snapshot: { id: number; wins: number; pointsFor: number; name: string }[] = [];
    for (const t of seasonTeams) {
      if (!knownIds.has(t.id)) continue;
      const rec = t.recordOverall ?? {};
      p.totals[t.id] = {
        wins: rec.wins ?? 0,
        losses: rec.losses ?? 0,
        ties: rec.ties ?? 0,
        pointsFor: t.pointsFor?.value ?? 0,
        pointsAgainst: t.pointsAgainst?.value ?? 0,
      };
      snapshot.push({ id: t.id, wins: rec.wins ?? 0, pointsFor: t.pointsFor?.value ?? 0, name: t.name });
    }

    const firstWeekRes = await fetchWithRetry(`https://www.fleaflicker.com/api/FetchLeagueScoreboard?sport=NFL&league_id=${leagueId}&season=${season}&scoring_period=1`);
    if (!firstWeekRes.ok) throw new Error(`Scoreboard discovery failed for season ${season} (HTTP ${firstWeekRes.status})`);
    const firstWeekData: any = await firstWeekRes.json();
    const eligiblePeriods: number[] = (firstWeekData?.eligibleSchedulePeriods ?? []).map((x: any) => x.ordinal).filter((n: any) => typeof n === 'number');
    const maxWeek = eligiblePeriods.length > 0 ? Math.max(...eligiblePeriods) : 1;
    const weekResults = await Promise.all(
      Array.from({ length: maxWeek }, (_, i) => i + 1).map(async (week) => {
        if (week === 1) return firstWeekData;
        const r = await fetchWithRetry(`https://www.fleaflicker.com/api/FetchLeagueScoreboard?sport=NFL&league_id=${leagueId}&season=${season}&scoring_period=${week}`);
        if (!r.ok) throw new Error(`Scoreboard failed for season ${season} week ${week} (HTTP ${r.status})`);
        return r.json();
      }),
    );

    for (const weekData of weekResults) {
      for (const g of (weekData?.games ?? []) as any[]) {
        const awayId = g?.away?.id;
        const homeId = g?.home?.id;
        if (!knownIds.has(awayId) || !knownIds.has(homeId)) continue;
        if (g?.isFinalScore) {
          const a = h2hFor(awayId, homeId);
          const h = h2hFor(homeId, awayId);
          if (g.awayResult === 'WIN') { a.wins++; h.losses++; }
          else if (g.awayResult === 'LOSE') { a.losses++; h.wins++; }
          else if (g.awayResult === 'TIE') { a.ties++; h.ties++; }
        }
        if (g?.isChampionshipGame || g?.isThirdPlaceGame) {
          // Only count a decided game — an unplayed title game has no result yet.
          if (g.awayResult !== 'WIN' && g.awayResult !== 'LOSE') continue;
          const awayWon = g.awayResult === 'WIN';
          const top: 1 | 3 = g.isChampionshipGame ? 1 : 3;
          p.postseason.push({ id: awayWon ? awayId : homeId, finish: { season, place: top, teamNameThatYear: awayWon ? g.away.name : g.home.name } });
          p.postseason.push({ id: awayWon ? homeId : awayId, finish: { season, place: (top + 1) as 2 | 4, teamNameThatYear: awayWon ? g.home.name : g.away.name } });
          if (g.isChampionshipGame) p.complete = true;
        }
      }
    }

    if (p.complete) {
      let worst: (typeof snapshot)[number] | null = null;
      for (const x of snapshot) {
        if (!worst || x.wins < worst.wins || (x.wins === worst.wins && x.pointsFor < worst.pointsFor)) worst = x;
      }
      if (worst) p.lastPlace = { id: worst.id, season, teamNameThatYear: worst.name };
    }
    return p;
  }

  try {
    const cached = (currentOnly ? await getJSON<Record<number, SeasonPartial>>(SEASONS_KEY) : null) ?? {};
    const partials: Record<number, SeasonPartial> = {};
    const fetched: number[] = [];
    for (const season of seasons) {
      const c = cached[season];
      if (c && c.complete && season < throughSeason) {
        partials[season] = c;
      } else {
        partials[season] = await computeSeason(season); // sequential — rate-limit margin
        fetched.push(season);
      }
    }
    await setJSON(SEASONS_KEY, partials);

    const allTime = new Map(teams.map((t) => [t.fleaflickerId, { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 }]));
    const h2h = new Map(teams.map((t) => [t.fleaflickerId, new Map<number, Rec>()]));
    const postseasonByTeam = new Map(teams.map((t) => [t.fleaflickerId, [] as PostseasonFinish[]]));
    const lastPlaceByTeam = new Map(teams.map((t) => [t.fleaflickerId, [] as { season: number; teamNameThatYear: string }[]]));
    const incompleteSeasons: number[] = [];
    for (const season of seasons) {
      const p = partials[season];
      for (const [id, t] of Object.entries(p.totals)) {
        const agg = allTime.get(Number(id));
        if (!agg) continue;
        agg.wins += t.wins; agg.losses += t.losses; agg.ties += t.ties;
        agg.pointsFor += t.pointsFor; agg.pointsAgainst += t.pointsAgainst;
      }
      for (const [id, opps] of Object.entries(p.h2h)) {
        const m = h2h.get(Number(id));
        if (!m) continue;
        for (const [opp, r] of Object.entries(opps)) {
          const cur = m.get(Number(opp)) ?? { wins: 0, losses: 0, ties: 0 };
          m.set(Number(opp), { wins: cur.wins + r.wins, losses: cur.losses + r.losses, ties: cur.ties + r.ties });
        }
      }
      for (const { id, finish } of p.postseason) postseasonByTeam.get(id)?.push(finish);
      if (p.lastPlace) lastPlaceByTeam.get(p.lastPlace.id)?.push({ season: p.lastPlace.season, teamNameThatYear: p.lastPlace.teamNameThatYear });
      if (!p.complete) incompleteSeasons.push(season);
    }

    const teamHistories: TeamHistory[] = teams.map((t) => {
      const headToHead: HeadToHead[] = teams
        .filter((other) => other.slug !== t.slug)
        .map((other) => {
          const rec = h2h.get(t.fleaflickerId)!.get(other.fleaflickerId) ?? { wins: 0, losses: 0, ties: 0 };
          return { opponentSlug: other.slug, ...rec };
        });

      return {
        teamSlug: t.slug,
        fleaflickerId: t.fleaflickerId,
        allTime: allTime.get(t.fleaflickerId)!,
        headToHead,
        postseasonFinishes: postseasonByTeam.get(t.fleaflickerId)!.sort((a, b) => a.season - b.season),
        lastPlaceFinishes: lastPlaceByTeam.get(t.fleaflickerId)!.sort((a, b) => a.season - b.season),
      };
    });

    const history: LeagueHistory = {
      computedAtEpochMilli: Date.now(),
      seasonsCovered: { from: START_SEASON, to: throughSeason },
      incompleteSeasons,
      teams: teamHistories,
    };

    await setJSON(HISTORY_KEY, history);

    return res.status(200).json({
      ok: true,
      message: `History updated for ${START_SEASON}-${throughSeason}; fetched from Fleaflicker: ${fetched.join(', ') || 'none'}.`,
      fetchedSeasons: fetched,
      incompleteSeasons,
      teamCount: teamHistories.length,
    });
  } catch (err: any) {
    return res.status(502).json({ error: `League history computation failed partway through: ${err?.message}. Nothing was saved — the old cached history (if any) is untouched.` });
  }
}
