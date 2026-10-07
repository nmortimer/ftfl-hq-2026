export interface Stadium {
  name: string;
  capacity: number;
  image: string;
}

export interface Team {
  slug: string;
  name: string;
  bg: string;      // darkest real color from the workbook's own fills
  accent: string;  // real color, used flat (no gradients) for headers/pills
  accent2: string; // real secondary color, used for borders/trim
  onAccent: string; // text color that reads on `accent` (#000-ish or #fff)
  logo: string;
  stadium?: Stadium; // only set for teams with stadium art so far
  fleaflickerId: number; // real team ID from Fleaflicker, confirmed against a live roster fetch
}

// Every value below is a RAW hex code pulled directly from the workbook —
// no brightening, no saturation boost, nothing synthesized. Method: counted
// every cell fill color AND font color per team tab, combined, and took the
// most frequent genuinely-distinctive colors. A couple of teams (Denver,
// South Bend) have their real accent color hiding in font colors rather
// than fills — e.g. Denver's bright green (#6CDF00) is used as text color
// hundreds of times but never as a fill, so a fills-only scan misses it
// entirely. See scripts/import-from-excel.py for the extraction.
//
// Stadium capacities are made up (asked to be) — not pulled from anything
// real. Only 6 teams have stadium art so far; the rest keep the "coming
// soon" placeholder until art exists for them too.
//
// fleaflickerId values are confirmed real (extracted from an actual
// FetchLeagueRosters response), not guessed.
export const teams: Team[] = [
  { slug: 'boulder-bandits', name: 'Boulder Bandits', bg: '#03182e', accent: '#1dd3e2', accent2: '#8a1b23', onAccent: '#0b0c10', logo: '/logos/boulder-bandits.png', fleaflickerId: 1417685, stadium: { name: 'Mortimer Stadium', capacity: 74911, image: '/stadiums/boulder-bandits.jpg' } },
  { slug: 'broad-ripple-big-horns', name: 'Broad Ripple Big Horns', bg: '#000000', accent: '#831400', accent2: '#6a6a6a', onAccent: '#ffffff', logo: '/logos/broad-ripple-big-horns.png', fleaflickerId: 1434371, stadium: { name: 'Broad Ripple Penitentiary Field', capacity: 71204, image: '/stadiums/broad-ripple-big-horns.jpg' } },
  { slug: 'denver-diamondbacks', name: 'Denver Diamondbacks', bg: '#1d1d1f', accent: '#6cdf00', accent2: '#483f30', onAccent: '#0b0c10', logo: '/logos/denver-diamondbacks.png', fleaflickerId: 1434157, stadium: { name: 'Copperhead Coliseum', capacity: 58000, image: '/stadiums/denver-diamondbacks.jpg' } },
  { slug: 'elkhart-express', name: 'Elkhart Express', bg: '#00274c', accent: '#ffcb05', accent2: '#ffffff', onAccent: '#0b0c10', logo: '/logos/elkhart-express.png', fleaflickerId: 1436853, stadium: { name: 'Railyard Arena', capacity: 61000, image: '/stadiums/elkhart-express.jpg' } },
  { slug: 'kansas-city-kaiju', name: 'Kansas City Kaiju', bg: '#000000', accent: '#d4af37', accent2: '#a42c25', onAccent: '#0b0c10', logo: '/logos/kansas-city-kaiju.png', fleaflickerId: 1432482, stadium: { name: 'North Kansas City High Field (temporary)', capacity: 9500, image: '/stadiums/kansas-city-kaiju.jpg' } },
  { slug: 'olde-town-osos', name: 'Olde Town Osos', bg: '#1b4500', accent: '#eb5202', accent2: '#fcf9dc', onAccent: '#ffffff', logo: '/logos/olde-town-osos.png', fleaflickerId: 1436073, stadium: { name: 'Putnam Memorial Stadium', capacity: 63150, image: '/stadiums/olde-town-osos.jpg' } },
  { slug: 'south-bend-silver-hawks', name: 'South Bend Silver Hawks', bg: '#017745', accent: '#c3c7c6', accent2: '#ffffff', onAccent: '#0b0c10', logo: '/logos/south-bend-silver-hawks.png', fleaflickerId: 1432373, stadium: { name: 'Studebaker Stadium', capacity: 57802, image: '/stadiums/south-bend-silver-hawks.jpg' } },
  { slug: 'strasbourg-soldiers', name: 'Strasbourg Soldiers', bg: '#10172a', accent: '#009fe3', accent2: '#88171a', onAccent: '#ffffff', logo: '/logos/strasbourg-soldiers.png', fleaflickerId: 1437039, stadium: { name: 'Stade de la Cathédrale', capacity: 54000, image: '/stadiums/strasbourg-soldiers.jpg' } },
  { slug: 'summit-county-ski-bums', name: 'Summit County Ski Bums', bg: '#0e5d78', accent: '#5cd8e4', accent2: '#ffffff', onAccent: '#0b0c10', logo: '/logos/summit-county-ski-bums.png', fleaflickerId: 1434105, stadium: { name: 'Vail Resorts Mountain Stadium', capacity: 48326, image: '/stadiums/summit-county-ski-bums.jpg' } },
  { slug: 'wakarusa-wizards', name: 'Wakarusa Wizards', bg: '#000000', accent: '#986c14', accent2: '#ffffff', onAccent: '#ffffff', logo: '/logos/wakarusa-wizards.png', fleaflickerId: 1432782, stadium: { name: 'Potter Park', capacity: 69633, image: '/stadiums/wakarusa-wizards.jpg' } },
];

export function teamBySlug(slug: string): Team {
  const t = teams.find((t) => t.slug === slug);
  if (!t) throw new Error(`Unknown team: ${slug}`);
  return t;
}
