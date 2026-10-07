import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { realContracts } from './data/realContracts';
import { teams, teamBySlug } from './data/teams';
import {
  fetchContracts,
  fetchFleaflickerActivity,
  fetchFleaflickerStandings,
  fetchLeagueHistory,
  fetchRosterCheck,
  fetchPowerRankings,
  fetchCurrentScoreboard,
  Scoreboard,
  PowerRankings,
  parseFpCsv,
  uploadFpRankings,
  FpKind,
  FpUploadMeta,
  RosterCheck,
  fetchTopScorers,
  FleaflickerActivityItem,
  FleaflickerTeamRecord,
  saveContracts,
  syncFromFleaflicker,
  SyncSummary,
  TopScorersResult,
} from './lib/api';
import type { LeagueHistory, TeamHistory } from './lib/leagueHistory';
import { winPct as historyWinPct } from './lib/leagueHistory';
import {
  BuyoutContract,
  Contract,
  MAX_TAXI_SPOTS,
  SALARY_CAP,
  buyoutScheduleFromCut,
  contractsForTeam,
  cutPenalty,
  endYear,
  irCount,
  isBuyout,
  isIR,
  isTaxi,
  projectedResignCost,
  rosterCount,
  salaryInYear,
  startYear,
  taxiCount,
  teamCapSpace,
  teamCapUsed,
  yearsRemaining,
} from './lib/contracts';

/** A cut is now a buyout, not a deletion — see buyoutScheduleFromCut for the per-year math. */
function toBuyout(contract: Contract, cutYear: number): BuyoutContract {
  return {
    id: contract.id,
    kind: 'buyout',
    playerName: contract.playerName,
    position: contract.position,
    team: contract.team,
    yearSalaries: buyoutScheduleFromCut(contract, cutYear),
  };
}

const YEARS = [2025, 2026, 2027, 2028, 2029];
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/** Same suffix/punctuation-stripping logic as api/sync.ts's normalize —
 * keeps "Michael Pittman Jr." and "Michael Pittman" matching here too. */
function normalizePlayerName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,'']/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function money(n: number | null): string {
  if (n == null) return '—';
  return `$${n}`;
}

export default function App() {
  const [year, setYear] = useState(2026);
  const [mode, setMode] = useState<'summary' | 'team' | 'activity'>('summary');
  const [teamSlug, setTeamSlug] = useState(teams[0].slug);
  const team = teamBySlug(teamSlug);

  // Contracts: render instantly from the bundled seed data, then swap in
  // live data from the backend if it's available. If there's no deployed
  // API or KV isn't configured yet, this silently stays on the seed data.
  const [contracts, setContracts] = useState<Contract[]>(realContracts);
  useEffect(() => {
    fetchContracts().then((live) => {
      if (live) setContracts(live);
    });
  }, []);

  // Commissioner tools are open for now — no login. See README for how to
  // re-lock this behind a password later.
  const isCommissioner = true;

  const themeVars =
    mode === 'team'
      ? { ['--bg' as any]: team.bg, ['--accent' as any]: team.accent, ['--accent2' as any]: team.accent2, ['--on-accent' as any]: team.onAccent }
      : mode === 'summary'
        ? { ['--bg' as any]: '#000000', ['--accent' as any]: '#0b2fa8', ['--accent2' as any]: '#fcfcfc', ['--on-accent' as any]: '#fcfcfc' }
        : { ['--bg' as any]: '#14161a', ['--accent' as any]: '#7f8a9e', ['--accent2' as any]: '#7f8a9e', ['--on-accent' as any]: '#0b0c10' };

  return (
    <div className={`page ${mode === 'summary' ? 'home' : ''}`} style={themeVars}>
      <nav className="team-rail">
        <button
          className={`team-chip summary-chip ${mode === 'summary' ? 'active' : ''}`}
          style={{ ['--chip' as any]: '#7f8a9e' }}
          onClick={() => setMode('summary')}
          title="League summary"
        >
          <span aria-hidden="true">⊞</span>
        </button>
        {teams.map((t) => (
          <button
            key={t.slug}
            className={`team-chip ${mode === 'team' && t.slug === teamSlug ? 'active' : ''}`}
            style={{ ['--chip' as any]: t.accent }}
            onClick={() => {
              setTeamSlug(t.slug);
              setMode('team');
            }}
            title={t.name}
          >
            <img src={t.logo} alt="" />
          </button>
        ))}
        <div className="year-picker rail-year">
          <label htmlFor="year">Viewing</label>
          <select id="year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {YEARS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <button className="commissioner-btn" onClick={() => setMode('activity')}>
          📋 FA Review
        </button>
      </nav>

      {mode === 'summary' ? (
        <LeagueSummary
          year={year}
          contracts={contracts}
          onSelectTeam={(slug) => {
            setTeamSlug(slug);
            setMode('team');
          }}
        />
      ) : mode === 'activity' ? (
        <ActivityReview contracts={contracts} setContracts={setContracts} year={year} />
      ) : (
        <TeamPage
          teamSlug={teamSlug}
          year={year}
          contracts={contracts}
          setContracts={setContracts}
          isCommissioner={isCommissioner}
        />
      )}
    </div>
  );
}

function LeagueSummary({
  year,
  contracts,
  onSelectTeam,
}: {
  year: number;
  contracts: Contract[];
  onSelectTeam: (slug: string) => void;
}) {
  const [records, setRecords] = useState<FleaflickerTeamRecord[] | null>(null);
  const [fleaflickerError, setFleaflickerError] = useState(false);

  useEffect(() => {
    setRecords(null);
    setFleaflickerError(false);
    fetchFleaflickerStandings(year).then((data) => {
      if (data) setRecords(data);
      else setFleaflickerError(true);
    });
  }, [year]);

  const rows = useMemo(
    () =>
      teams.map((t) => {
        const teamContracts = contractsForTeam(contracts, t.slug);
        const record = records?.find((r) => r.name.trim().toLowerCase() === t.name.trim().toLowerCase());
        return {
          team: t,
          capUsed: teamCapUsed(teamContracts, year),
          capSpace: teamCapSpace(teamContracts, year),
          roster: rosterCount(teamContracts, year),
          taxi: taxiCount(teamContracts, year),
          ir: irCount(teamContracts, year),
          record,
        };
      }),
    [contracts, year, records]
  );

  // Playoff order straight from Fleaflicker: its playoff seed (division
  // leaders first), then its overall rank. Record then points for is only a
  // fallback if those are ever missing.
  const standings = useMemo(() => {
    if (!records) return rows;
    const pct = (r?: FleaflickerTeamRecord) => {
      const g = r ? r.wins + r.losses + r.ties : 0;
      return g ? (r!.wins + r!.ties / 2) / g : 0;
    };
    return [...rows].sort(
      (a, b) =>
        (a.record?.seed ?? 99) - (b.record?.seed ?? 99) ||
        (a.record?.rank ?? 99) - (b.record?.rank ?? 99) ||
        pct(b.record) - pct(a.record) ||
        (b.record?.pointsFor ?? 0) - (a.record?.pointsFor ?? 0),
    );
  }, [rows, records]);

  return (
    <>
      <HomeHero year={year} records={records} />

      <PowerRankingsSection year={year} onSelectTeam={onSelectTeam}>
        <section className="roster-section">
          <h2 className="section-title">Standings and cap</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Seed</th>
                  <th>Team</th>
                  <th>Div</th>
                  <th>Record</th>
                  <th>PF</th>
                  <th>Roster</th>
                  <th>Taxi</th>
                  <th>IR</th>
                  <th>Cap used</th>
                  <th>Cap space</th>
                </tr>
              </thead>
              <tbody>
                {standings.map(({ team, capUsed, capSpace, roster, taxi, ir, record }, i) => (
                  <tr
                    key={team.slug}
                    className="clickable-row"
                    style={{ ['--team' as any]: team.accent }}
                    onClick={() => onSelectTeam(team.slug)}
                  >
                    <td className="num pr-rank">{records ? i + 1 : '—'}</td>
                    <td>
                      <div className="team-cell">
                        <img className="team-cell-logo" src={team.logo} alt="" />
                        {team.name}
                      </div>
                    </td>
                    <td>{record?.division ?? '—'}</td>
                    <td className="num">{record ? `${record.wins}-${record.losses}${record.ties ? `-${record.ties}` : ''}` : '—'}</td>
                    <td className="num">{record ? record.pointsFor.toFixed(1) : '—'}</td>
                    <td className="num">{roster}</td>
                    <td className={`num ${taxi > MAX_TAXI_SPOTS ? 'over' : ''}`}>{taxi}</td>
                    <td className="num">{ir}</td>
                    <td className="num">{money(capUsed)}</td>
                    <td className={`num ${capSpace < 0 ? 'over' : ''}`}>{money(capSpace)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {fleaflickerError && (
            <p className="footnote">
              Records aren't loading — check that FLEAFLICKER_LEAGUE_ID is set on the server.
            </p>
          )}
          <p className="footnote">
            Ordered by Fleaflicker's playoff seeding, division leaders first. Taxi squad and IR contracts don't count against the $200 cap.
          </p>
        </section>
      </PowerRankingsSection>
    </>
  );
}

function HomeHero({ year, records }: { year: number; records: FleaflickerTeamRecord[] | null }) {
  const [board, setBoard] = useState<Scoreboard | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setBoard(null);
    setFailed(false);
    fetchCurrentScoreboard(year).then((b) => (b ? setBoard(b) : setFailed(true)));
  }, [year]);

  const byName = (name: string) => teams.find((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase());
  const score = (n: number | null) => (n == null ? '—' : n.toFixed(1));
  const statusLabel = { final: 'Final', live: 'Live', upcoming: 'Upcoming' } as const;

  // Game of the week: the matchup between the two best teams in the
  // standings — lowest combined overall rank, most combined points as the
  // tiebreak. Shown first, in a gold frame.
  const recordFor = (name: string) => records?.find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase());
  const gotwId = useMemo(() => {
    if (!board || !records) return null;
    const rated = board.games
      .map((g) => ({ g, a: recordFor(g.away.name), h: recordFor(g.home.name) }))
      .filter((x) => x.a?.rank != null && x.h?.rank != null)
      .sort(
        (x, y) =>
          x.a!.rank! + x.h!.rank! - (y.a!.rank! + y.h!.rank!) ||
          y.a!.pointsFor + y.h!.pointsFor - (x.a!.pointsFor + x.h!.pointsFor),
      );
    return rated[0]?.g.id ?? null;
  }, [board, records]);
  const games = board ? [...board.games].sort((x, y) => Number(y.id === gotwId) - Number(x.id === gotwId)) : [];
  const recordText = (name: string) => {
    const r = recordFor(name);
    return r ? `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}` : '';
  };

  return (
    <header className="home-hero">
      <div className="hero-field" aria-hidden="true" />
      <div className="hero-title">
        <h1>FTFL</h1>
        <p>
          {year} season{board?.week ? `, week ${board.week}` : ''}
        </p>
      </div>
      <div className="scoreboard">
        {games.map((g) => {
          const featured = g.id === gotwId;
          const a = byName(g.away.name);
          const h = byName(g.home.name);
          const awayWin = g.status === 'final' && g.away.score != null && g.home.score != null && g.away.score > g.home.score;
          const homeWin = g.status === 'final' && g.away.score != null && g.home.score != null && g.home.score > g.away.score;
          return (
            <div className={`score-tile ${g.status} ${featured ? 'gotw' : ''}`} key={g.id}>
              {featured && <span className="gotw-label">Game of the week</span>}
              <span className="score-status">{statusLabel[g.status]}</span>
              {[
                { t: a, side: g.away, win: awayWin },
                { t: h, side: g.home, win: homeWin },
              ].map(({ t, side, win }, i) => (
                <div className={`score-line ${win ? 'win' : ''}`} key={i} style={{ ['--team' as any]: t?.accent ?? '#fcfcfc' }}>
                  {t && <img src={t.logo} alt="" />}
                  <span className="score-team">
                    {side.name}
                    {featured && <span className="score-record"> {recordText(side.name)}</span>}
                  </span>
                  <span className="score-pts">{score(side.score)}</span>
                </div>
              ))}
            </div>
          );
        })}
        {!board && !failed && <p className="hero-note">Loading this week's games…</p>}
        {failed && <p className="hero-note">This week's games aren't loading from Fleaflicker right now.</p>}
      </div>
    </header>
  );
}

const COMPONENT_LABELS: Record<string, string> = {
  wins: 'W',
  losses: 'L',
  pointsFor: 'PF',
  pointsAgainst: 'PA',
  allPlayWins: 'All-play',
  last5: 'Last 5',
  rosStrength: 'ROS (FP)',
  dynastyStrength: 'Dynasty (FP)',
};

function PowerRankingsSection({ year, onSelectTeam, children }: { year: number; onSelectTeam: (slug: string) => void; children?: ReactNode }) {
  const [data, setData] = useState<PowerRankings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(refresh = false) {
    setLoading(true);
    setError(null);
    const r = await fetchPowerRankings(year, refresh);
    setLoading(false);
    if (r.ok && r.data) setData(r.data);
    else setError(r.error ?? 'Failed to load');
  }
  useEffect(() => {
    setData(null);
    load();
  }, [year]);

  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [uploading, setUploading] = useState<FpKind | null>(null);
  async function handleUpload(kind: FpKind, file: File | undefined) {
    if (!file) return;
    setUploadMsg(null);
    const parsed = parseFpCsv(await file.text(), kind);
    if (parsed.error) return setUploadMsg(parsed.error);
    setUploading(kind);
    const r = await uploadFpRankings(year, kind, file.name, parsed.players);
    setUploading(null);
    if (!r.ok) return setUploadMsg(`Upload failed: ${r.error}`);
    setUploadMsg(`${kind === 'dynasty' ? 'Dynasty' : 'ROS'} ranks updated — ${r.count} players.`);
    load(true);
  }
  const uploadStatus = (m: FpUploadMeta | null | undefined) =>
    m
      ? `${m.count} players, uploaded ${new Date(m.uploadedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      : 'not uploaded';
  const unmatchedTotal = Object.values(data?.fp.unmatched ?? {}).reduce((a, l) => a + l.length, 0);

  const rec = (r: { wins: number; losses: number; ties: number }) => `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}`;
  const top = (t: [number, number, number] | undefined) => (t ? `${t[0]} / ${t[1]} / ${t[2]}` : '—');

  return (
    <>
      <section className="roster-section">
        <h2 className="section-title">Power rankings</h2>
        <div className="pr-tools">
          <details className="pr-how">
            <summary>How it's scored</summary>
            <p>
              Each factor ranks the 10 teams 1–10; the power score is the weighted average rank, so lower is better. ROS
              strength counts most (2×), PF and all-play 1.5×, PA least (0.5×). ROS /100 rates each team's best eight
              starters only; dynasty /100 is the best lineup plus a little depth (top 6 bench at 30%). Factors in use:{' '}
              {data ? data.activeComponents.map((k) => COMPONENT_LABELS[k] ?? k).join(', ') : '…'}
              {data && !data.last5Active && ' (last 5 kicks in at week 8)'}.
            </p>
          </details>
          <button className="btn-tiny" onClick={() => load(true)} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <div className="add-form-row fp-upload">
          {(['dynasty', 'ros'] as FpKind[]).map((kind) => (
            <label key={kind} className="btn-tiny fp-upload-btn">
              {uploading === kind ? 'Uploading…' : `Upload ${kind === 'dynasty' ? 'Dynasty' : 'ROS'} CSV`}
              <input
                type="file"
                accept=".csv,text/csv"
                hidden
                disabled={uploading !== null}
                onChange={(e) => {
                  handleUpload(kind, e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <span className="muted"> {uploadStatus(data?.fp[kind])}</span>
            </label>
          ))}
        </div>
        {uploadMsg && <p className="sync-line">{uploadMsg}</p>}
        {error && <p className="login-error">{error}</p>}
        {data?.fp?.error && <p className="login-error">FantasyPros: {data.fp.error}</p>}
        {data && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Team</th>
                  <th>Score</th>
                  <th>Record</th>
                  <th>PF</th>
                  <th>PA</th>
                  <th>All-play</th>
                  <th>Last 5</th>
                  <th title="Best starting lineup by FP rest-of-season ranks, strongest team = 100">ROS /100</th>
                  <th title="Best lineup + a little depth by FP dynasty ranks, strongest team = 100">Dynasty /100</th>
                  <th title="Players in FP dynasty top 25 / 50 / 100">Dynasty top 25/50/100</th>
                  <th title="Players in FP ROS top 25 / 50 / 100">ROS top 25/50/100</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => {
                  const t = teamBySlug(r.teamSlug);
                  return (
                    <tr
                      key={r.teamSlug}
                      className="clickable-row"
                      style={{ ['--team' as any]: t.accent }}
                      onClick={() => onSelectTeam(r.teamSlug)}
                    >
                      <td className={`num pr-rank ${i === 0 ? 'first' : ''}`}>{i + 1}</td>
                      <td>
                        <div className="team-cell">
                          <img className="team-cell-logo" src={t.logo} alt="" />
                          {t.name}
                        </div>
                      </td>
                      <td
                        className="num"
                        title={Object.entries(r.componentRanks)
                          .map(([k, v]) => `${COMPONENT_LABELS[k] ?? k}: #${v}`)
                          .join('\n')}
                      >
                        {r.powerScore.toFixed(2)}
                      </td>
                      <td className="num">{rec(r)}</td>
                      <td className="num">{r.pointsFor.toFixed(1)}</td>
                      <td className="num">{r.pointsAgainst.toFixed(1)}</td>
                      <td className="num">{`${r.allPlay.wins}-${r.allPlay.losses}`}</td>
                      <td className="num">{data.last5Active ? rec(r.last5) : '—'}</td>
                      <td className="num" title={r.fp ? `Starters: ${r.fp.rosStarters.join(', ')}` : ''}>
                        {r.fp ? r.fp.ros.toFixed(1) : '—'}
                      </td>
                      <td className="num" title={r.fp ? `Starters: ${r.fp.dynastyStarters.join(', ')}` : ''}>
                        {r.fp ? r.fp.dynasty.toFixed(1) : '—'}
                      </td>
                      <td className="num">{top(r.fp?.dynastyTop)}</td>
                      <td className="num">{top(r.fp?.rosTop)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <p className="footnote">
            Weeks counted: {data.weeksCounted.length ? data.weeksCounted.join(', ') : 'none final yet'}.
            Hover a score for each factor's rank.{' '}
            {unmatchedTotal > 0 && (
              <span
                className="fp-unmatched"
                title={Object.entries(data.fp.unmatched ?? {})
                  .filter(([, l]) => l.length)
                  .map(([slug, l]) => `${teamBySlug(slug).name}: ${l.join(', ')}`)
                  .join('\n')}
              >
                {unmatchedTotal} rostered players aren't in the dynasty CSV (hover to see who) — deep stashes are expected, a known name
                means a name mismatch.
              </span>
            )}
          </p>
        )}
      </section>

      {children}

      {data?.draftOrder && (data.draftOrder.rows || data.draftOrder.error) && (
        <section className="roster-section">
          <h2 className="section-title">Projected draft order</h2>
          <p className="section-note">
            Lowest optimum points for picks first.{' '}
            {data.draftOrder.source === 'computed'
              ? "Fleaflicker's Leaders page couldn't be read, so optimum points is worked out here from each week's best eight starters."
              : "Optimum PF comes straight from Fleaflicker's Leaders page."}
          </p>
          {data.draftOrder.error && <p className="login-error">Couldn't work out the draft order: {data.draftOrder.error}</p>}
          {data.draftOrder.rows && (
            <div className="table-scroll">
              <table className="draft-order">
                <thead>
                  <tr>
                    <th>Pick</th>
                    <th>Team</th>
                    <th>Optimum PF</th>
                    <th>Actual PF</th>
                    <th title="Actual points as a share of optimum points">Lineup efficiency</th>
                  </tr>
                </thead>
                <tbody>
                  {data.draftOrder.rows.map((r, i) => {
                    const t = teamBySlug(r.teamSlug);
                    return (
                      <tr
                        key={r.teamSlug}
                        className="clickable-row"
                        style={{ ['--team' as any]: t.accent }}
                        onClick={() => onSelectTeam(r.teamSlug)}
                      >
                        <td className={`num pr-rank ${i === 0 ? 'first' : ''}`}>{i + 1}</td>
                        <td>
                          <div className="team-cell">
                            <img className="team-cell-logo" src={t.logo} alt="" />
                            {t.name}
                          </div>
                        </td>
                        <td className="num">{r.opf.toFixed(1)}</td>
                        <td className="num">{r.pointsFor.toFixed(1)}</td>
                        <td className="num">{r.opf ? `${((r.pointsFor / r.opf) * 100).toFixed(1)}%` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {data && data.weeksCounted.length > 0 && (
        <section className="roster-section">
          <h2 className="section-title">If you had their schedule</h2>
          <p className="section-note">
            Row = team's actual weekly scores. Column = whose schedule they play. When a schedule faces the row team itself,
            it faces the column team instead. Diagonal = actual record.
          </p>
          <div className="table-scroll">
            <table className="schedule-matrix">
              <thead>
                <tr>
                  <th>Team ↓ / Schedule →</th>
                  {teams.map((c) => (
                    <th key={c.slug} title={c.name}>
                      <img className="team-cell-logo" src={c.logo} alt={c.name} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {teams.map((r) => (
                  <tr key={r.slug}>
                    <td>
                      <div className="team-cell">
                        <img className="team-cell-logo" src={r.logo} alt="" />
                        {r.name}
                      </div>
                    </td>
                    {teams.map((c) => {
                      const m = data.matrix[r.slug]?.[c.slug];
                      if (!m) return <td key={c.slug}>—</td>;
                      const games = m.wins + m.losses + m.ties;
                      const pct = games ? (m.wins + m.ties / 2) / games : 0;
                      return (
                        <td
                          key={c.slug}
                          className={`num matrix-cell ${r.slug === c.slug ? 'matrix-actual' : ''} ${pct >= 0.65 ? 'hot' : pct > 0.35 ? 'mid' : 'cold'}`}
                          title={`${r.name} with ${c.name}'s schedule`}
                        >
                          {rec(m)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function ActivityReview({
  contracts,
  setContracts,
  year,
}: {
  contracts: Contract[];
  setContracts: (c: Contract[]) => void;
  year: number;
}) {
  const [activity, setActivity] = useState<FleaflickerActivityItem[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { team: string; position: string; cost: number; length: number; deal: 'fa' | 'rookie'; taxi: boolean; ir: boolean }>>({});

  const [rosterCheck, setRosterCheck] = useState<RosterCheck | null>(null);
  const [rosterCheckError, setRosterCheckError] = useState<string | null>(null);
  const [mmCost, setMmCost] = useState<Record<string, number>>({});

  useEffect(() => {
    fetchFleaflickerActivity().then((data) => {
      if (data) setActivity(data);
      else setLoadError(true);
    });
  }, []);

  async function runRosterCheck() {
    setRosterCheckError(null);
    const r = await fetchRosterCheck(year);
    if (r.ok && r.data) setRosterCheck(r.data);
    else setRosterCheckError(r.error ?? 'Roster check failed');
  }

  // Runs on every visit to FA review — read-only, changes nothing.
  useEffect(() => {
    runRosterCheck();
  }, [year]);

  async function saveAndRecheck(updated: Contract[], okMsg: string) {
    setContracts(updated);
    setSaving(true);
    const result = await saveContracts(updated);
    setSaving(false);
    setSaveMsg(result.ok ? okMsg : `Changed locally, but saving failed: ${result.error}. Click "Save to server" to retry.`);
    if (result.ok) runRosterCheck();
  }

  function fillPositions() {
    const fixes = new Map((rosterCheck?.missingPositions ?? []).map((m) => [m.contractId, m.position]));
    const updated = contracts.map((c) => (fixes.has(c.id) ? { ...c, position: fixes.get(c.id)! } : c));
    saveAndRecheck(updated, `Filled positions for ${fixes.size} contract(s).`);
  }

  // Mismatch fix 1: a real trade — same contract, new team.
  function resolveAsTrade(m: RosterCheck['mismatches'][number]) {
    const updated = contracts.map((c) => (c.id === m.contractId ? { ...c, team: m.fleaflickerTeam } : c));
    saveAndRecheck(updated, `${m.playerName} moved to ${teamBySlug(m.fleaflickerTeam).name}.`);
  }

  // Mismatch fix 2: dropped by the sheet team, picked up by another —
  // old contract becomes a buyout for the dropping team, new 1-year deal
  // at the winning bid for the team that has him now.
  function resolveAsDropAdd(m: RosterCheck['mismatches'][number]) {
    const cost = mmCost[m.contractId] ?? 1;
    const old = contracts.find((c) => c.id === m.contractId);
    if (!old) return;
    if (!confirm(`${m.playerName}: buy out ${teamBySlug(m.sheetTeam).name}'s contract (50% of each remaining year) and sign him to ${teamBySlug(m.fleaflickerTeam).name} at $${cost} / 1 yr?`)) return;
    const newContract: Contract = {
      id: `fa-${Date.now()}`,
      kind: 'formula',
      playerName: old.playerName,
      position: old.position,
      team: m.fleaflickerTeam,
      baseSalary: cost,
      startYear: year,
      lengthYears: 1,
    };
    const updated = [...contracts.map((c) => (c.id === m.contractId ? toBuyout(c, year) : c)), newContract];
    saveAndRecheck(updated, `${m.playerName} bought out from ${teamBySlug(m.sheetTeam).name}, signed to ${teamBySlug(m.fleaflickerTeam).name} at $${cost}.`);
  }

  const findContract = (playerName: string) =>
    // Buyouts don't count: a buyout is dead money for the team that cut
    // him, not a roster spot. Counting them hid anyone re-signed after
    // being cut (Jordan Mason: Soldiers buyout through 2026, now on Osos).
    contracts.find((c) => c.kind !== 'buyout' && normalizePlayerName(c.playerName) === normalizePlayerName(playerName) && salaryInYear(c, year) != null);

  const logItems = (activity ?? []).filter((a) => a.kind === 'transaction' && a.playerName && !findContract(a.playerName));
  // Rostered players with no contract anywhere, from the roster check —
  // catches pickups older than the transaction log's first page.
  const logNames = new Set(logItems.map((a) => normalizePlayerName(a.playerName!)));
  const rosterItems: FleaflickerActivityItem[] = (rosterCheck?.unsigned ?? [])
    .filter((u) => !logNames.has(normalizePlayerName(u.playerName)) && !findContract(u.playerName))
    .map((u) => ({
      raw: null,
      timeEpochMilli: 0,
      kind: 'transaction' as const,
      playerName: u.playerName,
      position: u.position,
      isTaxi: u.isTaxi,
      isIR: u.isIR,
      teamName: teamBySlug(u.team).name,
      description: `On ${teamBySlug(u.team).name}'s Fleaflicker roster${u.isTaxi ? ' (TAXI)' : u.isIR ? ' (IR)' : ''}, no contract on file`,
    }));
  const faItems = [...logItems, ...rosterItems];
  const otherItems = (activity ?? []).filter((a) => !logItems.includes(a) && a.kind !== 'drop');
  const mismatches = (rosterCheck?.mismatches ?? []).filter((m) => contracts.some((c) => c.id === m.contractId && c.team === m.sheetTeam && c.kind !== 'buyout'));

  type Draft = { team: string; position: string; cost: number; length: number; deal: 'fa' | 'rookie'; taxi: boolean; ir: boolean };

  function draftFor(item: FleaflickerActivityItem): Draft {
    const matchedTeam = teams.find((t) => t.name.trim().toLowerCase() === (item.teamName ?? '').trim().toLowerCase());
    return (
      drafts[item.playerName!] ?? {
        team: matchedTeam?.slug ?? teams[0].slug,
        position: POSITIONS.includes(item.position ?? '') ? item.position! : 'WR',
        cost: 1,
        // FA pickups are 1-year deals at the winning bid. A player
        // Fleaflicker has on TAXI defaults to a rookie deal instead
        // (3 years, flat salary, taxi-tagged) — e.g. Fernando Mendoza.
        deal: item.isTaxi ? 'rookie' : 'fa',
        length: item.isTaxi ? 3 : 1,
        taxi: Boolean(item.isTaxi),
        ir: Boolean(item.isIR),
      }
    );
  }

  // Takes the full item (not just the name) so the auto-matched team
  // survives editing another field first.
  function updateDraft(item: FleaflickerActivityItem, patch: Partial<Draft>) {
    setDrafts({ ...drafts, [item.playerName!]: { ...draftFor(item), ...patch } });
  }

  async function addFromDraft(item: FleaflickerActivityItem) {
    const d = draftFor(item);
    const years = Array.from({ length: d.deal === 'fa' ? 1 : d.length }, (_, i) => year + i);
    // Rookie deals are FLAT (same salary every year — matches every taxi
    // contract in the imported sheet: Cam Ward 2/2/2, Oscar Delp 2/2,
    // Malachi Fields 3/3), so they're stored as explicit per-year salaries,
    // not as a formula contract (which would escalate). Taxi/IR tags cover
    // every contract year, same convention as the imported sheet; Sync
    // updates the current year as players get promoted/activated.
    const newContract: Contract =
      d.deal === 'rookie'
        ? {
            id: `fa-${Date.now()}`,
            kind: 'imported',
            playerName: item.playerName!,
            position: d.position,
            team: d.team,
            yearSalaries: Object.fromEntries(years.map((y) => [y, d.cost])),
            ...(d.taxi ? { taxiYears: years } : {}),
            ...(d.ir ? { irYears: years } : {}),
          }
        : {
            id: `fa-${Date.now()}`,
            kind: 'formula',
            playerName: item.playerName!,
            position: d.position,
            team: d.team,
            baseSalary: d.cost,
            startYear: year,
            lengthYears: 1,
            ...(d.ir ? { irYears: [year] } : {}),
          };
    const updated = [...contracts, newContract];
    setContracts(updated);
    // Saves immediately, same as confirmCut. Before this, adding the last
    // pending pickup emptied faItems, which unmounted the only "Save to
    // server" button — so the add lived in local state only and vanished
    // on the next reload or Sync (handleSync overwrites with server data).
    setSaving(true);
    const result = await saveContracts(updated);
    setSaving(false);
    setSaveMsg(
      result.ok
        ? `${item.playerName} added and saved (${d.deal === 'rookie' ? `$${d.cost}/yr × ${d.length}${d.taxi ? ', taxi' : ''}` : `$${d.cost} / 1 yr`}).`
        : `${item.playerName} added locally, but saving failed: ${result.error}. Click "Save to server" to retry — don't run Sync until this saves.`,
    );
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    const result = await saveContracts(contracts);
    setSaving(false);
    setSaveMsg(result.ok ? 'Saved.' : `Not saved: ${result.error}`);
  }

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    setSyncSummary(null);
    const result = await syncFromFleaflicker(year);
    setSyncing(false);
    if (result.ok && result.summary) {
      setSyncSummary(result.summary);
      const live = await fetchContracts();
      if (live) setContracts(live);
      runRosterCheck();
    } else {
      setSyncError(result.error ?? 'Sync failed');
    }
  }

  async function confirmCut(id: string) {
    const c = contracts.find((x) => x.id === id);
    if (!c) return;
    if (!confirm(`Cut ${c.playerName}? This converts their contract into a buyout — it'll keep counting against ${teamBySlug(c.team).name}'s cap for the years remaining, at 50% of each year's salary. Only do this once you've verified in Fleaflicker that they're really gone — "not found" can also mean a data mismatch, not a real cut.`)) return;
    const updated = contracts.map((x) => (x.id === id ? toBuyout(x, year) : x));
    setContracts(updated);
    setSyncSummary((s) => (s ? { ...s, proposedCuts: s.proposedCuts.filter((p) => p.id !== id) } : s));
    // Saves immediately, on purpose — confirming a cut used to only update
    // local state, requiring a separate manual "Save to server" click
    // afterward. If that click was skipped and Sync got run again before
    // it, handleSync's own fetchContracts() call would silently overwrite
    // the unsaved buyout with the server's stale (still-active) contract,
    // and Fleaflicker would propose the exact same cut again — forever,
    // until someone remembered the save step at exactly the right moment.
    setSaving(true);
    const result = await saveContracts(updated);
    setSaving(false);
    setSaveMsg(result.ok ? `${c.playerName} cut and saved.` : `Cut applied locally, but saving failed: ${result.error}. Click "Save to server" below to retry — don't run Sync again until this saves.`);
  }

  function dismissCut(id: string) {
    setSyncSummary((s) => (s ? { ...s, proposedCuts: s.proposedCuts.filter((p) => p.id !== id) } : s));
  }

  const totalSyncChanges = syncSummary
    ? syncSummary.trades.length + syncSummary.taxiChanges.length + syncSummary.irChanges.length + syncSummary.proposedCuts.length
    : 0;

  return (
    <>
      <header className="page-header summary-header">
        <div>
          <h1>Free agent review</h1>
          <p className="sub">
            Trades and taxi/IR sync automatically from Fleaflicker. Cuts need a quick confirm below — a cut
            removes a contract for good, so nothing gets deleted without a human double-check.
          </p>
        </div>
      </header>

      <div className="commissioner-bar">
        <button className="btn-primary" onClick={handleSync} disabled={syncing}>
          {syncing ? 'Syncing…' : '🔄 Sync trades + check for cuts'}
        </button>
        {syncError && <span className="login-error">{syncError}</span>}
      </div>

      {syncSummary && (
        <section className="roster-section">
          <h2 className="section-title">Sync results</h2>
          {totalSyncChanges === 0 ? (
            <p className="muted">No changes — everything already matches Fleaflicker's rosters.</p>
          ) : (
            <>
              {syncSummary.trades.map((t) => (
                <p className="sync-line" key={`trade-${t.name}`}>
                  Traded: <strong>{t.name}</strong> — {teamBySlug(t.from).name} → {teamBySlug(t.to).name}
                </p>
              ))}
              {syncSummary.taxiChanges.map((line) => (
                <p className="sync-line" key={`taxi-${line}`}>
                  {line}
                </p>
              ))}
              {syncSummary.irChanges.map((line) => (
                <p className="sync-line" key={`ir-${line}`}>
                  {line}
                </p>
              ))}
              {syncSummary.proposedCuts.map((cut) => (
                <div className="add-form-row drop-row" key={cut.id}>
                  <span>
                    <strong>{cut.playerName}</strong> ({teamBySlug(cut.team).name}) — not found on any Fleaflicker
                    roster
                  </span>
                  <button className="btn-tiny btn-danger" onClick={() => confirmCut(cut.id)}>
                    Confirm cut
                  </button>
                  <button className="btn-tiny" onClick={() => dismissCut(cut.id)}>
                    Not a real cut, ignore
                  </button>
                </div>
              ))}
            </>
          )}
          {syncSummary.proposedCuts.length > 0 && (
            <div className="commissioner-bar" style={{ marginTop: 12 }}>
              <button className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save to server'}
              </button>
              {saveMsg && <span className="save-msg">{saveMsg}</span>}
            </div>
          )}
        </section>
      )}


      <section className="roster-section">
        <h2 className="section-title">Team check</h2>
        <p className="section-note">
          Every Fleaflicker roster compared against the contracts on file. Runs automatically; nothing changes until you
          click a fix.{' '}
          <button className="btn-tiny" onClick={runRosterCheck}>
            Re-run
          </button>
        </p>
        {rosterCheckError && <p className="login-error">{rosterCheckError}</p>}
        {rosterCheck && mismatches.length === 0 && rosterCheck.notOnRoster.length === 0 && rosterItems.length === 0 && logItems.length === 0 && (
          <p className="muted">All 10 teams match Fleaflicker.</p>
        )}
        {mismatches.map((m) => (
          <div className="add-form-row drop-row" key={m.contractId}>
            <span>
              <strong>{m.playerName}</strong> — sheet: {teamBySlug(m.sheetTeam).name}, Fleaflicker:{' '}
              {teamBySlug(m.fleaflickerTeam).name}
            </span>
            <button className="btn-tiny" onClick={() => resolveAsTrade(m)} disabled={saving}>
              Trade — move contract
            </button>
            <label className="fa-cost">
              Won for $
              <input
                type="number"
                min={1}
                value={mmCost[m.contractId] ?? 1}
                onChange={(e) => setMmCost({ ...mmCost, [m.contractId]: Number(e.target.value) })}
              />
            </label>
            <button className="btn-tiny btn-danger" onClick={() => resolveAsDropAdd(m)} disabled={saving || !((mmCost[m.contractId] ?? 1) >= 1)}>
              Dropped &amp; picked up — buy out + sign 1 yr
            </button>
          </div>
        ))}
        {rosterCheck && (rosterCheck.missingPositions ?? []).length > 0 && (
          <div className="add-form-row">
            <span>
              {rosterCheck.missingPositions!.length} contract(s) have no position, so they don't show in any position
              section on the team sheet.
            </span>
            <button className="btn-tiny" onClick={fillPositions} disabled={saving}>
              Fill missing positions from Fleaflicker
            </button>
          </div>
        )}
        {rosterCheck && rosterCheck.notOnRoster.length > 0 && (
          <p className="sync-line">
            On file but not on any Fleaflicker roster:{' '}
            {rosterCheck.notOnRoster.map((n) => `${n.playerName} (${teamBySlug(n.sheetTeam).name})`).join(', ')} — run Sync to
            confirm cuts.
          </p>
        )}
        {faItems.length > 0 && <p className="sync-line">{faItems.length} rostered player(s) with no contract — enter costs below.</p>}
      </section>

      {loadError && (
        <p className="footnote">
          Couldn't reach Fleaflicker's transaction log — check FLEAFLICKER_LEAGUE_ID is set and try again.
        </p>
      )}

      {activity && faItems.length === 0 && !loadError && (
        <p className="muted">No pending free agent pickups without a contract on file — you're caught up.</p>
      )}

      {faItems.map((item) => {
        const d = draftFor(item);
        return (
          <section className="roster-section add-contract-form" key={item.playerName}>
            <h2 className="section-title">{item.playerName}</h2>
            <p className="section-note">{item.description}</p>
            <div className="add-form-row">
              <select value={d.team} onChange={(e) => updateDraft(item, { team: e.target.value })}>
                {teams.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name}
                  </option>
                ))}
              </select>
              <select value={d.position} onChange={(e) => updateDraft(item, { position: e.target.value })}>
                {POSITIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <label className="fa-cost">
                {d.deal === 'rookie' ? 'Salary $' : 'Won for $'}
                <input
                  type="number"
                  min={1}
                  value={d.cost}
                  onChange={(e) => updateDraft(item, { cost: Number(e.target.value) })}
                  title="Winning bid — not tracked in Fleaflicker, enter manually"
                />
              </label>
              <select
                value={d.deal}
                onChange={(e) => {
                  const deal = e.target.value as Draft['deal'];
                  updateDraft(item, { deal, length: deal === 'fa' ? 1 : 3 });
                }}
              >
                <option value="fa">FA pickup — 1 yr</option>
                <option value="rookie">Rookie deal — flat</option>
              </select>
              {d.deal === 'rookie' && (
                <select value={d.length} onChange={(e) => updateDraft(item, { length: Number(e.target.value) })}>
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n} yr
                    </option>
                  ))}
                </select>
              )}
              <label className="fa-cost">
                <input type="checkbox" checked={d.taxi} onChange={(e) => updateDraft(item, { taxi: e.target.checked })} /> Taxi
              </label>
              <label className="fa-cost">
                <input type="checkbox" checked={d.ir} onChange={(e) => updateDraft(item, { ir: e.target.checked })} /> IR
              </label>
              <button className="btn-primary" onClick={() => addFromDraft(item)} disabled={saving || !(d.cost >= 1)}>
                {d.deal === 'rookie' ? `Add $${d.cost}/yr × ${d.length}` : `Add $${d.cost} / 1 yr`}
              </button>
            </div>
          </section>
        );
      })}

      {(faItems.length > 0 || saveMsg) && (
        <div className="commissioner-bar">
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save to server'}
          </button>
          {saveMsg && <span className="save-msg">{saveMsg}</span>}
        </div>
      )}

      {otherItems.length > 0 && (
        <section className="roster-section">
          <h2 className="section-title">Other recent activity</h2>
          <p className="section-note">Informational only — not confirmed as actionable transactions.</p>
          {otherItems.slice(0, 15).map((item, i) => (
            <details key={i} className="activity-raw">
              <summary>{item.description}</summary>
              <pre>{JSON.stringify(item.raw, null, 2)}</pre>
            </details>
          ))}
        </section>
      )}
    </>
  );
}

function TeamPage({
  teamSlug,
  year,
  contracts,
  setContracts,
  isCommissioner,
}: {
  teamSlug: string;
  year: number;
  contracts: Contract[];
  setContracts: (c: Contract[]) => void;
  isCommissioner: boolean;
}) {
  const team = teamBySlug(teamSlug);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [history, setHistory] = useState<LeagueHistory | null>(null);
  const [topScorers, setTopScorers] = useState<TopScorersResult | null>(null);

  useEffect(() => {
    fetchLeagueHistory().then(setHistory);
    fetchTopScorers().then(setTopScorers);
  }, []);

  const teamContracts = useMemo(() => contractsForTeam(contracts, teamSlug), [contracts, teamSlug]);

  const withComputed = useMemo(
    () =>
      teamContracts.map((c: Contract) => ({
        contract: c,
        salary: salaryInYear(c, year),
        yearsLeft: yearsRemaining(c, year),
        penalty: cutPenalty(c, year),
      })),
    [teamContracts, year]
  );

  const active = withComputed.filter((r) => !isBuyout(r.contract) && r.salary != null && !isTaxi(r.contract, year) && !isIR(r.contract, year));
  const taxi = withComputed.filter((r) => !isBuyout(r.contract) && r.salary != null && isTaxi(r.contract, year));
  const ir = withComputed.filter((r) => !isBuyout(r.contract) && r.salary != null && isIR(r.contract, year));
  const buyouts = withComputed.filter((r) => isBuyout(r.contract) && r.salary != null);

  const capUsed = teamCapUsed(teamContracts, year);
  const capSpace = teamCapSpace(teamContracts, year);

  function updateContract(id: string, patch: Partial<Contract>) {
    setContracts(contracts.map((c) => (c.id === id ? ({ ...c, ...patch } as Contract) : c)));
  }

  // For contracts entered in this app by mistake (ids "fa-…"/"new-…") —
  // removes the row outright. Not a cut: no buyout is created. Imported
  // sheet contracts can't be deleted this way.
  function deleteMistake(id: string) {
    const c = contracts.find((x) => x.id === id);
    if (!c) return;
    if (!confirm(`Delete ${c.playerName}'s contract entirely? Use this only for an entry made by mistake — no buyout is created. Remember to Save.`)) return;
    setContracts(contracts.filter((x) => x.id !== id));
  }

  function cutContract(id: string) {
    const c = contracts.find((x) => x.id === id);
    if (!c) return;
    if (!confirm(`Cut ${c.playerName}? This converts their contract into a buyout — it'll keep counting against the cap for the years remaining, at 50% of each year's salary.`)) return;
    setContracts(contracts.map((x) => (x.id === id ? toBuyout(x, year) : x)));
  }

  function tradeContract(id: string, newTeamSlug: string) {
    if (!newTeamSlug || newTeamSlug === teamSlug) return;
    updateContract(id, { team: newTeamSlug });
  }

  function toggleTaxiThisYear(contract: Contract) {
    const years = contract.taxiYears ?? [];
    const addingToTaxi = !isTaxi(contract, year);
    if (addingToTaxi) {
      const currentTaxi = taxiCount(teamContracts, year);
      if (currentTaxi >= MAX_TAXI_SPOTS) {
        alert(`Taxi squad is full (${MAX_TAXI_SPOTS} max). Remove someone from taxi first.`);
        return;
      }
    }
    const next = addingToTaxi ? [...years, year] : years.filter((y) => y !== year);
    updateContract(contract.id, { taxiYears: next });
  }

  function toggleIRThisYear(contract: Contract) {
    const years = contract.irYears ?? [];
    const next = isIR(contract, year) ? years.filter((y) => y !== year) : [...years, year];
    updateContract(contract.id, { irYears: next });
  }

  function addContract(form: { name: string; position: string; baseSalary: number; lengthYears: number }) {
    const newContract: Contract = {
      id: `new-${Date.now()}`,
      kind: 'formula',
      playerName: form.name,
      position: form.position,
      team: teamSlug,
      baseSalary: form.baseSalary,
      startYear: year,
      lengthYears: form.lengthYears,
    };
    setContracts([...contracts, newContract]);
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    const result = await saveContracts(contracts);
    setSaving(false);
    setSaveMsg(result.ok ? 'Saved.' : `Not saved: ${result.error}`);
  }

  const rowTable = (rows: typeof active, opts?: { badge?: 'taxi' | 'ir' }) => (
    <table>
      <thead>
        <tr>
          <th>Player</th>
          <th>Pos</th>
          <th>Contract</th>
          <th>Salary in {year}</th>
          <th>Years left</th>
          <th>Cut penalty if cut now</th>
          {editMode && <th>Edit</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ contract, salary, yearsLeft, penalty }) => {
          const signed = startYear(contract);
          const resignYear = endYear(contract) + 1;
          const resignCost = projectedResignCost(contract);
          return (
            <tr key={contract.id}>
              <td>
                {contract.playerName}
                {opts?.badge === 'taxi' && <span className="badge taxi">Taxi</span>}
                {opts?.badge === 'ir' && <span className="badge ir">IR</span>}
              </td>
              <td>
                {editMode ? (
                  <input
                    className="edit-input edit-input-pos"
                    value={contract.position}
                    onChange={(e) => updateContract(contract.id, { position: e.target.value })}
                  />
                ) : (
                  contract.position || '—'
                )}
              </td>
              <td>
                <div className="contract-cell">
                  <span className="contract-signed">Signed {signed}</span>
                  <span className="contract-resign">
                    Resign: {money(resignCost)} ({resignYear})
                  </span>
                </div>
              </td>
              <td className="num">{money(salary)}</td>
              <td className="num">{yearsLeft}</td>
              <td className="num">{money(penalty)}</td>
              {editMode && (
                <td className="edit-actions">
                  <button className="btn-tiny" onClick={() => toggleTaxiThisYear(contract)}>
                    {isTaxi(contract, year) ? 'Un-taxi' : 'Taxi'}
                  </button>
                  <button className="btn-tiny" onClick={() => toggleIRThisYear(contract)}>
                    {isIR(contract, year) ? 'Un-IR' : 'IR'}
                  </button>
                  <button className="btn-tiny btn-danger" onClick={() => cutContract(contract.id)}>
                    Cut
                  </button>
                  {(contract.id.startsWith('fa-') || contract.id.startsWith('new-')) && contract.kind !== 'buyout' && (
                    <button className="btn-tiny" onClick={() => deleteMistake(contract.id)} title="Remove an entry made by mistake — no buyout">
                      Delete
                    </button>
                  )}
                  <select
                    className="edit-input trade-select"
                    value=""
                    onChange={(e) => tradeContract(contract.id, e.target.value)}
                  >
                    <option value="" disabled>
                      Trade to…
                    </option>
                    {teams
                      .filter((t) => t.slug !== teamSlug)
                      .map((t) => (
                        <option key={t.slug} value={t.slug}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <>
      <header className="page-header">
        <div className="team-identity">
          <img className="team-logo" src={team.logo} alt={`${team.name} logo`} />
          <h1>{team.name}</h1>
        </div>

        {team.stadium ? (
          <div className="stadium-inline">
            <img className="stadium-inline-img" src={team.stadium.image} alt={team.stadium.name} />
            <div className="stadium-inline-caption">
              <span className="stadium-inline-name">{team.stadium.name}</span>
              <span className="stadium-inline-capacity">Capacity: {team.stadium.capacity.toLocaleString()}</span>
            </div>
          </div>
        ) : (
          <div className="stadium-inline stadium-inline-placeholder">
            <span>Stadium art — coming soon</span>
          </div>
        )}

        <div className="color-legend">
          <span className="legend-title">Team colors</span>
          <div className="swatch-row">
            <div className="swatch-item">
              <span className="swatch-block" style={{ background: team.accent }} />
              <span className="swatch-name">Primary</span>
              <span className="swatch-hex">{team.accent}</span>
            </div>
            <div className="swatch-item">
              <span className="swatch-block" style={{ background: team.accent2 }} />
              <span className="swatch-name">Secondary</span>
              <span className="swatch-hex">{team.accent2}</span>
            </div>
            <div className="swatch-item">
              <span className="swatch-block" style={{ background: team.bg }} />
              <span className="swatch-name">Base</span>
              <span className="swatch-hex">{team.bg}</span>
            </div>
          </div>
        </div>
      </header>

      {isCommissioner && (
        <div className="commissioner-bar">
          <button className="btn-secondary" onClick={() => setEditMode((e) => !e)}>
            {editMode ? 'Done editing' : 'Edit roster'}
          </button>
          {editMode && (
            <>
              <button className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save to server'}
              </button>
              {saveMsg && <span className="save-msg">{saveMsg}</span>}
            </>
          )}
        </div>
      )}

      <div className="cap-summary">
        <div className="cap-block">
          <span className="cap-label">Cap used</span>
          <span className="cap-value">{money(capUsed)}</span>
        </div>
        <div className="cap-bar">
          <div
            className={`cap-fill ${capSpace < 0 ? 'over' : ''}`}
            style={{ width: `${Math.min(100, (capUsed / SALARY_CAP) * 100)}%` }}
          />
        </div>
        <div className="cap-block">
          <span className="cap-label">Cap space</span>
          <span className={`cap-value ${capSpace < 0 ? 'over' : ''}`}>{money(capSpace)}</span>
        </div>
      </div>

      <div className="team-page-columns">
      <div className="team-page-left">
      {POSITIONS.map((pos) => {
          const rows = active.filter((r) => r.contract.position === pos);
          if (rows.length === 0) return null;
          return (
            <section className="roster-section" key={pos}>
              <h2 className="section-title">{pos}</h2>
              {rowTable(rows)}
            </section>
          );
        })}
      {/* Contracts with a blank/unknown position used to match no section
          and silently disappear from the sheet (Devin Neal — imported with
          position ''). Shown here until positions are filled in. */}
      {(() => {
        const rows = active.filter((r) => !POSITIONS.includes(r.contract.position));
        if (rows.length === 0) return null;
        return (
          <section className="roster-section">
            <h2 className="section-title">Position missing</h2>
            <p className="section-note">Fill these from FA review → Team check → "Fill missing positions".</p>
            {rowTable(rows)}
          </section>
        );
      })()}
      </div>

      <div className="team-page-right">
        <HistoryBox history={history} topScorers={topScorers} teamSlug={teamSlug} />

        {ir.length > 0 && (
          <section className="roster-section">
            <h2 className="section-title">Injured reserve</h2>
            <p className="section-note">Does not count against the cap.</p>
            {rowTable(ir, { badge: 'ir' })}
          </section>
        )}

        {taxi.length > 0 && (
          <section className="roster-section">
            <h2 className="section-title">
              Taxi squad ({taxi.length}/{MAX_TAXI_SPOTS})
              {taxi.length > MAX_TAXI_SPOTS && <span className="badge over-limit">Over limit</span>}
            </h2>
            <p className="section-note">
              Does not count against the cap. Max {MAX_TAXI_SPOTS} spots.
              {taxi.length > MAX_TAXI_SPOTS && ' This team is over the limit — Fleaflicker sync reflects what\'s actually on their taxi squad there, so fix it on Fleaflicker directly rather than here.'}
            </p>
            {rowTable(taxi, { badge: 'taxi' })}
          </section>
        )}

        {buyouts.length > 0 && (
          <section className="roster-section">
            <h2 className="section-title">Buyouts</h2>
            <p className="section-note">Cut players — no roster spot, but still counts against the cap until it runs out.</p>
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Buyout cost in {year}</th>
                  <th>Years left</th>
                </tr>
              </thead>
              <tbody>
                {buyouts.map(({ contract, salary, yearsLeft }) => (
                  <tr key={contract.id}>
                    <td>
                      {contract.playerName}
                      <span className="badge">Buyout</span>
                    </td>
                    <td className="num">{money(salary)}</td>
                    <td className="num">{yearsLeft}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
      </div>

      {editMode && <AddContractForm onAdd={addContract} />}

      <p className="footnote">
        "Resign" projects the final contracted rate forward using the confirmed escalation increment for as
        many years as the player has been at that rate. This is a consistent anchor, not a market-value
        forecast. A cut becomes a buyout: for every year that would have remained on the deal, 50% of that
        year's own salary counts against the cap, rounded up per year — a $5 year becomes a $3 buyout year on
        its own, not folded into one lump total.
      </p>
    </>
  );
}

function HistoryBox({ history, topScorers, teamSlug }: { history: LeagueHistory | null; topScorers: TopScorersResult | null; teamSlug: string }) {
  const team = teamBySlug(teamSlug);

  if (!history) {
    return (
      <section className="roster-section history-box">
        <h2 className="section-title">All-time history</h2>
        <p className="section-note">Not computed yet.</p>
      </section>
    );
  }

  const h: TeamHistory | undefined = history.teams.find((t) => t.teamSlug === teamSlug);
  if (!h) {
    return (
      <section className="roster-section history-box">
        <h2 className="section-title">All-time history</h2>
        <p className="section-note">No history found for this team.</p>
      </section>
    );
  }

  const pct = historyWinPct(h.allTime);
  const championships = h.postseasonFinishes.filter((f) => f.place === 1);
  const runnerUps = h.postseasonFinishes.filter((f) => f.place === 2);
  const thirds = h.postseasonFinishes.filter((f) => f.place === 3);
  const lastPlaces = h.lastPlaceFinishes;

  const finishLabel = (season: number, teamNameThatYear: string) =>
    teamNameThatYear.trim().toLowerCase() === team.name.trim().toLowerCase() ? `${season}` : `${season} (as ${teamNameThatYear})`;

  return (
    <section className="roster-section history-box">
      <h2 className="section-title">
        All-time history <span className="history-range">{history.seasonsCovered.from}–{history.seasonsCovered.to}</span>
      </h2>

      <div className="history-record">
        <span className="history-record-line">
          {h.allTime.wins}-{h.allTime.losses}
          {h.allTime.ties > 0 ? `-${h.allTime.ties}` : ''} ({(pct * 100).toFixed(1)}%)
        </span>
        <span className="history-points">
          {h.allTime.pointsFor.toFixed(0)} PF / {h.allTime.pointsAgainst.toFixed(0)} PA
        </span>
      </div>

      <div className="history-finishes">
        <div className="history-finish-row">
          <span className="history-finish-label">🏆 Championships ({championships.length})</span>
          <span className="history-finish-years">
            {championships.length === 0 ? '—' : championships.map((f) => finishLabel(f.season, f.teamNameThatYear)).join(', ')}
          </span>
        </div>
        <div className="history-finish-row">
          <span className="history-finish-label">🥈 Runner-up ({runnerUps.length})</span>
          <span className="history-finish-years">
            {runnerUps.length === 0 ? '—' : runnerUps.map((f) => finishLabel(f.season, f.teamNameThatYear)).join(', ')}
          </span>
        </div>
        <div className="history-finish-row">
          <span className="history-finish-label">🥉 Third place ({thirds.length})</span>
          <span className="history-finish-years">
            {thirds.length === 0 ? '—' : thirds.map((f) => finishLabel(f.season, f.teamNameThatYear)).join(', ')}
          </span>
        </div>
        <div className="history-finish-row">
          <span className="history-finish-label">Last place ({lastPlaces.length})</span>
          <span className="history-finish-years">
            {lastPlaces.length === 0 ? '—' : lastPlaces.map((f) => finishLabel(f.season, f.teamNameThatYear)).join(', ')}
          </span>
        </div>
      </div>

      <div className="history-h2h">
        <h3 className="history-h2h-title">Head-to-head</h3>
        {teams
          .filter((t) => t.slug !== teamSlug)
          .map((opp) => {
            const rec = h.headToHead.find((r) => r.opponentSlug === opp.slug) ?? { wins: 0, losses: 0, ties: 0 };
            return (
              <div className="history-h2h-row" key={opp.slug}>
                <span className="history-h2h-opponent">
                  <img className="history-h2h-logo" src={opp.logo} alt="" />
                  {opp.name}
                </span>
                <span className="history-h2h-record">
                  {rec.wins}-{rec.losses}
                  {rec.ties > 0 ? `-${rec.ties}` : ''}
                </span>
              </div>
            );
          })}
      </div>

      {(() => {
        const teamScorers = topScorers?.teams.find((t) => t.teamSlug === teamSlug);
        if (!teamScorers) {
          return <p className="section-note history-topscorer-note">Top scorer by position — not computed yet.</p>;
        }
        return (
          <div className="history-topscorers">
            <h3 className="history-h2h-title">Top scorer by position (career)</h3>
            {teamScorers.scorers.map((s) => (
              <div className="history-finish-row" key={s.position}>
                <span className="history-finish-label">{s.position}</span>
                <span className="history-finish-years">
                  {s.playerName === '—' ? '—' : `${s.playerName} (${s.totalPoints.toFixed(1)})`}
                </span>
              </div>
            ))}
          </div>
        );
      })()}
    </section>
  );
}

function AddContractForm({
  onAdd,
}: {
  onAdd: (form: { name: string; position: string; baseSalary: number; lengthYears: number }) => void;
}) {
  const [name, setName] = useState('');
  const [position, setPosition] = useState('QB');
  const [baseSalary, setBaseSalary] = useState(1);
  const [lengthYears, setLengthYears] = useState(3);

  return (
    <section className="roster-section add-contract-form">
      <h2 className="section-title">Add contract</h2>
      <div className="add-form-row">
        <input placeholder="Player name" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={position} onChange={(e) => setPosition(e.target.value)}>
          {POSITIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          placeholder="Base salary"
          value={baseSalary}
          onChange={(e) => setBaseSalary(Number(e.target.value))}
        />
        <input
          type="number"
          min={1}
          max={6}
          placeholder="Years"
          value={lengthYears}
          onChange={(e) => setLengthYears(Number(e.target.value))}
        />
        <button
          className="btn-primary"
          onClick={() => {
            if (!name.trim()) return;
            onAdd({ name: name.trim(), position, baseSalary, lengthYears });
            setName('');
            setBaseSalary(1);
            setLengthYears(3);
          }}
        >
          Add
        </button>
      </div>
    </section>
  );
}
