import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getJSON, setJSON } from './_lib/store.js';
import { teams } from '../src/data/teams.js';
import { currentNflSeason, fetchWithRetry } from './compute-league-history.js';
import { fetchRosterMap, normalize } from './sync.js';

/**
 * Power rankings + "if you had their schedule" matrix, one endpoint.
 *
 * Fleaflicker (FetchLeagueScoreboard, same calls league history makes):
 *   W, L, PF, PA, all-play wins, last-5 record (counts from week 8 on),
 *   and the schedule matrix. Only weeks where EVERY game is final count.
 *
 * FantasyPros (CSV uploads — the free API key is capped at 10 players):
 *   The commissioner uploads FP's Dynasty and ROS "ALL" CSV exports on the
 *   league summary page. The browser parses them and POSTs
 *   { kind, fileName, players: [{ name, rank, pos }] } here; stored in
 *   Redis (ftfl:fp-upload:dynasty / :ros) and used until the next upload.
 *   Each list feeds its own factor, so one can be uploaded without the other.
 *
 * UNCONFIRMED until checked against a real response:
 *   Fleaflicker weekly score path game.homeScore.score.value — fails
 *   loudly with a raw sample game if wrong.
 *
 * Cached 3h in Redis; ?refresh=1 forces a rebuild.
 */

// ---- Tuning (edit here) -------------------------------------------------
// Each component ranks the 10 teams 1-10; power score = weighted average
// rank (lower = better). Equal weights = exactly the formula as given.
// Record is W + L (2 total); PA is mostly luck so it counts least;
// ROS lineup strength counts most (best predictor of the rest of the
// season); dynasty matters but is mostly a long-term signal.
export const WEIGHTS = {
  wins: 1,
  losses: 1,
  pointsFor: 1.5,
  pointsAgainst: 0.5, // lower PA ranks better
  allPlayWins: 1.5,
  last5: 1, // only applied once LAST5_START_WEEK is reached
  rosStrength: 2,
  dynastyStrength: 1,
};
const LAST5_START_WEEK = 8;

// FTFL lineup, CONFIRMED from the league's own rosterRequirements in a real
// FetchLeagueStandings response (starterCount 8): QB, RB, RB, WR, WR, TE,
// and TWO RB/WR/TE flex spots. (An earlier version assumed one flex, which
// is what made week-1 optimal points come out below a real score.)
const LINEUP = { QB: 1, RB: 2, WR: 2, TE: 1 } as const;
const FLEX = ['RB', 'WR', 'TE'];
const FLEX_COUNT = 2;
// Player value from FP overall rank, top-heavy so stars matter more than
// a pile of depth: #1 = 100, #24 ≈ 71, #50 ≈ 48, #100 ≈ 22, #200 ≈ 5.
const playerValue = (rank: number | undefined) => (rank ? 100 * Math.pow(0.985, rank - 1) : 0);
// Dynasty also credits SOME depth: the best 6 non-starters at 30% each.
// Capped so a full roster isn't rewarded for sheer size. ROS = starters only.
const DYNASTY_BENCH_COUNT = 6;
const DYNASTY_BENCH_WEIGHT = 0.3;
const CACHE_HOURS = 3;
// -------------------------------------------------------------------------

type Rec = { wins: number; losses: number; ties: number };
interface TeamStrength {
  dynasty: number; // 0-100, strongest team = 100
  ros: number; // 0-100, strongest team = 100
  rosStarters: string[];
  dynastyStarters: string[];
  dynastyTop: [number, number, number];
  rosTop: [number, number, number];
  matched: number;
}

/** Best legal FTFL lineup by value. Returns starter names, their value, and the rest sorted by value. */
function bestLineup(players: { name: string; pos: string; value: number }[]) {
  const pool = [...players].sort((a, b) => b.value - a.value);
  const starters: typeof pool = [];
  for (const [pos, n] of Object.entries(LINEUP)) {
    for (let i = 0; i < n; i++) {
      const idx = pool.findIndex((p) => p.pos === pos);
      if (idx >= 0) starters.push(pool.splice(idx, 1)[0]);
    }
  }
  for (let i = 0; i < FLEX_COUNT; i++) {
    const flexIdx = pool.findIndex((p) => FLEX.includes(p.pos));
    if (flexIdx >= 0) starters.push(pool.splice(flexIdx, 1)[0]);
  }
  return { starters, bench: pool, value: starters.reduce((a, p) => a + p.value, 0) };
}
interface FpPlayer {
  name: string;
  rank: number;
  pos?: string;
}
type FpKind = 'dynasty' | 'ros';
interface FpUpload {
  uploadedAt: number;
  fileName: string;
  players: FpPlayer[];
}
const fpKey = (kind: FpKind) => `ftfl:fp-upload:${kind}`;

/** POST { kind, fileName, players } — saves one uploaded FantasyPros list. */
async function saveFpUpload(req: VercelRequest, res: VercelResponse, cacheKey: string) {
  const { kind, fileName, players } = (req.body ?? {}) as { kind?: string; fileName?: string; players?: unknown };
  if (kind !== 'dynasty' && kind !== 'ros') return res.status(400).json({ error: 'kind must be "dynasty" or "ros"' });
  if (!Array.isArray(players)) return res.status(400).json({ error: 'players must be an array' });
  const clean: FpPlayer[] = players
    .map((p: any) => ({ name: String(p?.name ?? '').trim(), rank: Number(p?.rank), pos: p?.pos ? String(p.pos) : undefined }))
    .filter((p) => p.name && Number.isFinite(p.rank) && p.rank > 0);
  // Real exports are 400-600 rows; anything tiny is the wrong file or a bad parse.
  if (clean.length < 50) return res.status(400).json({ error: `Only ${clean.length} valid rows — is this the full "ALL" export?` });
  const upload: FpUpload = { uploadedAt: Date.now(), fileName: String(fileName ?? ''), players: clean };
  await setJSON(fpKey(kind), upload);
  await setJSON(cacheKey, null); // next GET rebuilds with the new ranks
  return res.status(200).json({ ok: true, kind, count: clean.length });
}

function rankTeams(values: Map<string, number>, higherIsBetter: boolean): Map<string, number> {
  const sorted = [...values.entries()].sort((a, b) => (higherIsBetter ? b[1] - a[1] : a[1] - b[1]));
  const ranks = new Map<string, number>();
  sorted.forEach(([slug, v], i) => {
    // ties share the better rank
    const prev = sorted[i - 1];
    ranks.set(slug, prev && prev[1] === v ? ranks.get(prev[0])! : i + 1);
  });
  return ranks;
}

/**
 * Optimal points for (OPF) per team for one completed week: the best legal
 * lineup (QB, RB, RB, WR, WR, TE, FLEX, FLEX) from everyone who was startable —
 * starters plus bench. Taxi and IR players are excluded (they couldn't
 * have been started).
 *
 * Boxscore shape is the one confirmed for top scorers: box.lineups[] groups
 * ("START", bench = no group key, "INJURED", "TAXI"), each slot carrying
 * .away/.home with proPlayer.position and viewingActualPoints.value.
 *
 * Players are assigned to a team by which SIDE of the boxscore they're on
 * (away/home, known from the scoreboard), not by the slot's owner.id —
 * the side can't change if a player is dropped or traded later.
 */
interface WeekTeam {
  opf: number;
  startedSum: number;
  started: string[]; // "Name POS pts" — only used in error messages
}
async function weekOpf(
  leagueId: string,
  week: number,
  games: { id: string; away: string; home: string }[],
): Promise<Record<string, WeekTeam>> {
  const boxes = await Promise.all(
    games.map(async (g) => {
      const r = await fetchWithRetry(`https://www.fleaflicker.com/api/FetchLeagueBoxscore?sport=NFL&league_id=${leagueId}&fantasy_game_id=${g.id}&scoring_period=${week}`);
      if (!r.ok) throw new Error(`Boxscore ${g.id} (week ${week}) failed (HTTP ${r.status})`);
      return { game: g, box: (await r.json()) as any };
    }),
  );
  const pool = new Map<string, { name: string; pos: string; value: number; started: boolean }[]>();
  for (const { game, box } of boxes) {
    for (const group of box?.lineups ?? []) {
      if (group?.group && group.group !== 'START') continue; // skip INJURED / TAXI
      for (const slot of group?.slots ?? []) {
        for (const sideKey of ['away', 'home'] as const) {
          const side = slot?.[sideKey];
          const player = side?.proPlayer;
          if (!player?.nameFull) continue;
          const slug = game[sideKey];
          if (!pool.has(slug)) pool.set(slug, []);
          pool.get(slug)!.push({
            name: player.nameFull,
            pos: player.position ?? '',
            value: side?.viewingActualPoints?.value ?? 0,
            started: group?.group === 'START',
          });
        }
      }
    }
  }
  const out: Record<string, WeekTeam> = {};
  for (const [slug, players] of pool) {
    const starters = players.filter((p) => p.started);
    out[slug] = {
      opf: Math.round(bestLineup(players).value * 100) / 100,
      startedSum: Math.round(starters.reduce((a, p) => a + p.value, 0) * 100) / 100,
      started: starters.map((p) => `${p.name} ${p.pos || '?'} ${p.value}`),
    };
  }
  return out;
}

/**
 * Fleaflicker's own "Optimum PF", read from the league's public Leaders
 * page (/nfl/leagues/<id>/leaders). It isn't in the JSON API (checked the
 * real FetchLeagueStandings response), so this reads the HTML table.
 *
 * Built from the real page as fetched Oct 7 2026: one row per team, the
 * last column reading like "482.4 (73.31%)", with PF in the column before
 * it. To survive layout changes it doesn't count columns — it finds the
 * cell with a known team name and the cell shaped "number (percent%)".
 * Returns null (so the caller falls back to computing OPF) unless all 10
 * teams are found with an optimum at or above their points for.
 */
export function parseLeadersHtml(html: string): Record<string, { opf: number; pointsFor: number }> | null {
  const text = (cell: string) =>
    cell
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  const num = (v: string) => Number(v.replace(/,/g, ''));
  const out: Record<string, { opf: number; pointsFor: number }> = {};
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map(text);
    const team = teams.find((t) => cells.some((c) => c.toLowerCase() === t.name.toLowerCase()));
    if (!team) continue;
    const i = cells.findIndex((c) => /^[\d,]+(\.\d+)?\s*\(\s*[\d.]+%\s*\)$/.test(c));
    if (i < 1) continue;
    const opf = num(cells[i].split('(')[0].trim());
    const pointsFor = num(cells[i - 1]);
    if (!Number.isFinite(opf) || !Number.isFinite(pointsFor) || opf + 0.05 < pointsFor) continue;
    out[team.slug] = { opf, pointsFor };
  }
  return Object.keys(out).length === teams.length ? out : null;
}

async function fetchLeadersOpf(leagueId: string, season: number) {
  const r = await fetchWithRetry(`https://www.fleaflicker.com/nfl/leagues/${leagueId}/leaders?season=${season}`);
  if (!r.ok) return null;
  return parseLeadersHtml(await r.text());
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const leagueId = process.env.FLEAFLICKER_LEAGUE_ID;
  if (!leagueId) return res.status(400).json({ error: 'FLEAFLICKER_LEAGUE_ID is not set on the server.' });
  const season = Number(req.query.year) || currentNflSeason();
  const cacheKey = `ftfl:power-rankings:v2:${season}`; // v2: lineup fixed to two flex spots

  if (req.method === 'POST') return saveFpUpload(req, res, cacheKey);

  if (req.query.refresh !== '1') {
    const cached = await getJSON<any>(cacheKey);
    if (cached && Date.now() - cached.computedAtEpochMilli < CACHE_HOURS * 3600_000) return res.status(200).json(cached);
  }

  const idToSlug = new Map(teams.map((t) => [t.fleaflickerId, t.slug]));

  // ---- Fleaflicker: weekly scores + matchups ----------------------------
  let weeks: { week: number; score: Map<string, number>; opp: Map<string, string>; games: { id: string; away: string; home: string }[] }[] = [];
  try {
    const first = await fetchWithRetry(`https://www.fleaflicker.com/api/FetchLeagueScoreboard?sport=NFL&league_id=${leagueId}&season=${season}&scoring_period=1`);
    if (!first.ok) throw new Error(`Scoreboard failed (HTTP ${first.status})`);
    const firstData: any = await first.json();
    const periods: number[] = (firstData?.eligibleSchedulePeriods ?? []).map((p: any) => p.ordinal).filter((n: any) => typeof n === 'number');
    const maxWeek = periods.length ? Math.max(...periods) : 1;
    const all = await Promise.all(
      Array.from({ length: maxWeek }, (_, i) => i + 1).map(async (w) => {
        if (w === 1) return firstData;
        const r = await fetchWithRetry(`https://www.fleaflicker.com/api/FetchLeagueScoreboard?sport=NFL&league_id=${leagueId}&season=${season}&scoring_period=${w}`);
        if (!r.ok) throw new Error(`Scoreboard week ${w} failed (HTTP ${r.status})`);
        return r.json();
      }),
    );

    for (let i = 0; i < all.length; i++) {
      const games: any[] = (all[i]?.games ?? []).filter((g: any) => idToSlug.has(g?.home?.id) && idToSlug.has(g?.away?.id));
      // Regular-season-style weeks only: every team plays, every game final.
      if (games.length === 0 || games.length * 2 !== teams.length || !games.every((g) => g?.isFinalScore)) continue;
      if (games.some((g) => g?.isChampionshipGame || g?.isThirdPlaceGame)) continue;
      const score = new Map<string, number>();
      const opp = new Map<string, string>();
      for (const g of games) {
        const h = idToSlug.get(g.home.id)!;
        const a = idToSlug.get(g.away.id)!;
        const hs = g?.homeScore?.score?.value;
        const as = g?.awayScore?.score?.value;
        if (typeof hs !== 'number' || typeof as !== 'number') {
          return res.status(502).json({
            error: `Week ${i + 1}: couldn't read scores at game.homeScore.score.value — field path needs confirming. Raw sample game:`,
            sampleGame: g,
          });
        }
        score.set(h, hs);
        score.set(a, as);
        opp.set(h, a);
        opp.set(a, h);
      }
      weeks.push({
        week: i + 1,
        score,
        opp,
        games: games.map((g) => ({ id: String(g.id), away: idToSlug.get(g.away.id)!, home: idToSlug.get(g.home.id)! })),
      });
    }
  } catch (err: any) {
    return res.status(502).json({ error: `Fleaflicker: ${err?.message}` });
  }

  const slugs = teams.map((t) => t.slug);
  const blank = () => new Map(slugs.map((s) => [s, 0]));
  const W = blank(), L = blank(), T = blank(), PF = blank(), PA = blank(), AP = blank(), APL = blank();
  for (const { score, opp } of weeks) {
    for (const s of slugs) {
      const mine = score.get(s)!;
      const theirs = score.get(opp.get(s)!)!;
      PF.set(s, PF.get(s)! + mine);
      PA.set(s, PA.get(s)! + theirs);
      if (mine > theirs) W.set(s, W.get(s)! + 1);
      else if (mine < theirs) L.set(s, L.get(s)! + 1);
      else T.set(s, T.get(s)! + 1);
      for (const o of slugs) {
        if (o === s) continue;
        if (mine > score.get(o)!) AP.set(s, AP.get(s)! + 1);
        else if (mine < score.get(o)!) APL.set(s, APL.get(s)! + 1);
      }
    }
  }

  const completedWeeks = weeks.length ? weeks[weeks.length - 1].week : 0;
  const last5Active = completedWeeks >= LAST5_START_WEEK;
  const last5Weeks = weeks.slice(-5);
  const last5 = new Map<string, Rec>(slugs.map((s) => [s, { wins: 0, losses: 0, ties: 0 }]));
  for (const { score, opp } of last5Weeks) {
    for (const s of slugs) {
      const r = last5.get(s)!;
      const d = score.get(s)! - score.get(opp.get(s)!)!;
      if (d > 0) r.wins++;
      else if (d < 0) r.losses++;
      else r.ties++;
    }
  }

  // Schedule matrix: row team's scores vs. column team's opponents.
  // When the column team's opponent IS the row team, it faces the column team.
  const matrix: Record<string, Record<string, Rec>> = {};
  for (const r of slugs) {
    matrix[r] = {};
    for (const c of slugs) {
      const rec = { wins: 0, losses: 0, ties: 0 };
      for (const { score, opp } of weeks) {
        let o = opp.get(c)!;
        if (o === r) o = c;
        const d = score.get(r)! - score.get(o)!;
        if (d > 0) rec.wins++;
        else if (d < 0) rec.losses++;
        else rec.ties++;
      }
      matrix[r][c] = rec;
    }
  }

  // ---- FantasyPros strength (from uploaded CSVs) --------------------------
  const meta = (u: FpUpload | null) => (u ? { uploadedAt: u.uploadedAt, fileName: u.fileName, count: u.players.length } : null);
  let fp: {
    dynasty: ReturnType<typeof meta>;
    ros: ReturnType<typeof meta>;
    error?: string;
    strength?: Record<string, TeamStrength>;
    unmatched?: Record<string, string[]>;
  } = { dynasty: null, ros: null };
  try {
    const [dyn, ros] = await Promise.all([getJSON<FpUpload>(fpKey('dynasty')), getJSON<FpUpload>(fpKey('ros'))]);
    fp = { dynasty: meta(dyn), ros: meta(ros) };
    if (dyn || ros) {
      const roster = (await fetchRosterMap(leagueId, season)).map;
      const dynRank = new Map((dyn?.players ?? []).map((p) => [normalize(p.name), p.rank]));
      const rosRank = new Map((ros?.players ?? []).map((p) => [normalize(p.name), p.rank]));
      // Each team's current Fleaflicker roster, with positions from Fleaflicker.
      const byTeam = new Map(slugs.map((sl) => [sl, [] as { key: string; name: string; pos: string }[]]));
      for (const [key, info] of roster) byTeam.get(info.teamSlug)?.push({ key, name: info.playerName, pos: info.position ?? '' });

      const raw = new Map<string, { dyn: number; ros: number; rosStarters: string[]; dynastyStarters: string[]; dynastyTop: [number, number, number]; rosTop: [number, number, number]; matched: number }>();
      const unmatched: Record<string, string[]> = {};
      const topCounts = (ranks: (number | undefined)[]): [number, number, number] => [
        ranks.filter((r) => r != null && r <= 25).length,
        ranks.filter((r) => r != null && r <= 50).length,
        ranks.filter((r) => r != null && r <= 100).length,
      ];
      for (const [sl, players] of byTeam) {
        const rosL = bestLineup(players.map((p) => ({ name: p.name, pos: p.pos, value: playerValue(rosRank.get(p.key)) })));
        const dynL = bestLineup(players.map((p) => ({ name: p.name, pos: p.pos, value: playerValue(dynRank.get(p.key)) })));
        const depth = dynL.bench.slice(0, DYNASTY_BENCH_COUNT).reduce((a, p) => a + p.value, 0) * DYNASTY_BENCH_WEIGHT;
        raw.set(sl, {
          ros: rosL.value,
          dyn: dynL.value + depth,
          rosStarters: rosL.starters.filter((p) => p.value > 0).map((p) => p.name),
          dynastyStarters: dynL.starters.filter((p) => p.value > 0).map((p) => p.name),
          dynastyTop: topCounts(players.map((p) => dynRank.get(p.key))),
          rosTop: topCounts(players.map((p) => rosRank.get(p.key))),
          matched: players.filter((p) => dynRank.has(p.key)).length,
        });
        // Offensive players missing from the dynasty list — usually deep
        // stashes, but a known name here means a name mismatch to fix.
        if (dyn) unmatched[sl] = players.filter((p) => ['QB', 'RB', 'WR', 'TE'].includes(p.pos) && !dynRank.has(p.key)).map((p) => p.name);
      }
      const maxRos = Math.max(...[...raw.values()].map((r) => r.ros), 1);
      const maxDyn = Math.max(...[...raw.values()].map((r) => r.dyn), 1);
      const strength: Record<string, TeamStrength> = {};
      for (const [sl, r] of raw) {
        strength[sl] = {
          ros: Math.round((r.ros / maxRos) * 1000) / 10,
          dynasty: Math.round((r.dyn / maxDyn) * 1000) / 10,
          rosStarters: r.rosStarters,
          dynastyStarters: r.dynastyStarters,
          dynastyTop: r.dynastyTop,
          rosTop: r.rosTop,
          matched: r.matched,
        };
      }
      fp.strength = strength;
      fp.unmatched = unmatched;
    }
  } catch (err: any) {
    fp.error = err?.message;
  }

  // ---- Projected draft order: reverse optimal points for ------------------
  // Completed weeks never change, so each week's OPF is computed once and
  // kept in Redis; a normal load only fetches boxscores for a new week.
  let draftOrder: {
    rows?: { teamSlug: string; opf: number; pointsFor: number }[];
    weeks?: number[];
    source?: 'fleaflicker' | 'computed';
    error?: string;
  } = {};
  // First choice: Fleaflicker's own Optimum PF from its Leaders page — the
  // number the league already sees, in one request. Only if that page can't
  // be read does it fall back to computing OPF from boxscores below.
  const leaders = await fetchLeadersOpf(leagueId, season).catch(() => null);
  if (leaders) {
    draftOrder = {
      source: 'fleaflicker',
      rows: slugs.map((sl) => ({ teamSlug: sl, ...leaders[sl] })).sort((a, b) => a.opf - b.opf), // lowest OPF picks first
    };
  } else
  try {
    const opfKey = `ftfl:opf:${season}`;
    const opfByWeek = (await getJSON<Record<number, Record<string, number>>>(opfKey)) ?? {};
    let added = false;
    for (const w of weeks) {
      if (opfByWeek[w.week]) continue;
      const full = await weekOpf(leagueId, w.week, w.games); // one week at a time — rate-limit margin
      // Two checks before trusting a week, each with enough detail in the
      // message to see the cause without another round trip:
      //  1. the players read as started must add up to the real score
      //  2. the best possible lineup can't score less than the real one
      for (const sl of slugs) {
        const t = full[sl];
        const actual = w.score.get(sl)!;
        if (!t) throw new Error(`week ${w.week}: no boxscore players found for ${sl}.`);
        if (Math.abs(t.startedSum - actual) > 0.05) {
          throw new Error(
            `week ${w.week}, ${sl}: the starters read from the boxscore add up to ${t.startedSum}, but the real score was ${actual}. Starters read: ${t.started.join('; ')}.`,
          );
        }
        if (t.opf + 0.05 < actual) {
          throw new Error(
            `week ${w.week}, ${sl}: best lineup came out as ${t.opf}, below the real ${actual} — a starter is in a spot the QB/RB/RB/WR/WR/TE/FLEX/FLEX lineup doesn't allow. Starters read: ${t.started.join('; ')}.`,
          );
        }
      }
      const wk = Object.fromEntries(slugs.map((sl) => [sl, full[sl].opf]));
      opfByWeek[w.week] = wk;
      added = true;
    }
    if (added) await setJSON(opfKey, opfByWeek);
    if (weeks.length > 0) {
      draftOrder = {
        source: 'computed',
        weeks: weeks.map((w) => w.week),
        rows: slugs
          .map((sl) => ({
            teamSlug: sl,
            opf: Math.round(weeks.reduce((a, w) => a + opfByWeek[w.week][sl], 0) * 100) / 100,
            pointsFor: Math.round(PF.get(sl)! * 100) / 100,
          }))
          .sort((a, b) => a.opf - b.opf), // lowest OPF picks first
      };
    }
  } catch (err: any) {
    draftOrder = { error: err?.message };
  }

  // ---- Power score --------------------------------------------------------
  const components: { key: keyof typeof WEIGHTS; values: Map<string, number>; higherIsBetter: boolean; active: boolean }[] = [
    { key: 'wins', values: W, higherIsBetter: true, active: true },
    { key: 'losses', values: L, higherIsBetter: false, active: true },
    { key: 'pointsFor', values: PF, higherIsBetter: true, active: true },
    { key: 'pointsAgainst', values: PA, higherIsBetter: false, active: true },
    { key: 'allPlayWins', values: AP, higherIsBetter: true, active: true },
    {
      key: 'last5',
      values: new Map(slugs.map((s) => [s, last5.get(s)!.wins + last5.get(s)!.ties / 2])),
      higherIsBetter: true,
      active: last5Active,
    },
    {
      key: 'rosStrength',
      values: new Map(slugs.map((s) => [s, fp.strength?.[s]?.ros ?? 0])),
      higherIsBetter: true,
      active: Boolean(fp.ros && fp.strength),
    },
    {
      key: 'dynastyStrength',
      values: new Map(slugs.map((s) => [s, fp.strength?.[s]?.dynasty ?? 0])),
      higherIsBetter: true,
      active: Boolean(fp.dynasty && fp.strength),
    },
  ];
  const active = components.filter((c) => c.active && WEIGHTS[c.key] > 0 && (c.key.endsWith('Strength') || weeks.length > 0));
  const componentRanks = Object.fromEntries(active.map((c) => [c.key, rankTeams(c.values, c.higherIsBetter)]));
  const totalWeight = active.reduce((a, c) => a + WEIGHTS[c.key], 0);

  const rows = slugs
    .map((s) => {
      const ranks = Object.fromEntries(active.map((c) => [c.key, componentRanks[c.key].get(s)!]));
      const score = totalWeight ? active.reduce((a, c) => a + WEIGHTS[c.key] * componentRanks[c.key].get(s)!, 0) / totalWeight : 0;
      return {
        teamSlug: s,
        powerScore: Math.round(score * 100) / 100,
        wins: W.get(s)!,
        losses: L.get(s)!,
        ties: T.get(s)!,
        pointsFor: Math.round(PF.get(s)! * 100) / 100,
        pointsAgainst: Math.round(PA.get(s)! * 100) / 100,
        allPlay: { wins: AP.get(s)!, losses: APL.get(s)! },
        last5: last5.get(s)!,
        fp: fp.strength?.[s] ?? null,
        componentRanks: ranks,
      };
    })
    .sort((a, b) => a.powerScore - b.powerScore);

  const result = {
    computedAtEpochMilli: Date.now(),
    season,
    completedWeeks,
    weeksCounted: weeks.map((w) => w.week),
    last5Active,
    activeComponents: active.map((c) => c.key),
    weights: WEIGHTS,
    rows,
    matrix,
    draftOrder,
    fp: { dynasty: fp.dynasty, ros: fp.ros, error: fp.error, unmatched: fp.unmatched },
  };
  await setJSON(cacheKey, result);
  return res.status(200).json(result);
}
