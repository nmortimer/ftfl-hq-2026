// League history — computed once by api/compute-league-history.ts (a heavy,
// many-season aggregation over Fleaflicker's standings + scoreboard
// endpoints) and cached in Redis. Read live by api/league-history.ts.
// Nothing here is computed client-side; the frontend only ever displays
// whatever's already cached.

export interface PostseasonFinish {
  season: number;
  place: 1 | 2 | 3 | 4; // 1=champion, 2=runner-up, 3=third, 4=lost third-place game
  teamNameThatYear: string; // franchise identity is stable (see fleaflickerId), display name isn't
}

export interface LastPlaceFinish {
  season: number;
  teamNameThatYear: string;
}

export interface HeadToHead {
  opponentSlug: string;
  wins: number;
  losses: number;
  ties: number;
}

export interface TeamHistory {
  teamSlug: string;
  fleaflickerId: number;
  allTime: { wins: number; losses: number; ties: number; pointsFor: number; pointsAgainst: number };
  headToHead: HeadToHead[]; // one entry per other team in the league
  postseasonFinishes: PostseasonFinish[]; // every 1st/2nd/3rd/4th across all seasons covered
  lastPlaceFinishes: LastPlaceFinish[];
}

export interface LeagueHistory {
  computedAtEpochMilli: number;
  seasonsCovered: { from: number; to: number };
  incompleteSeasons: number[]; // seasons with standings data but no detected champion yet (in progress)
  teams: TeamHistory[];
}

export function winPct(h: TeamHistory['allTime']): number {
  const total = h.wins + h.losses + h.ties;
  if (total === 0) return 0;
  return (h.wins + h.ties * 0.5) / total;
}
