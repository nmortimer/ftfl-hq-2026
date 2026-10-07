// Core FTFL contract math. Two kinds of contract, one shared interface:
//
// - "imported" contracts are real history, copied verbatim from the master
//   spreadsheet. Their per-year salary is whatever is actually in the
//   sheet — never recomputed, because the escalation rule wasn't applied
//   consistently across 9 years of manual edits and renegotiations.
// - "formula" contracts are new deals signed going forward, through the
//   commissioner screen. Their salary in any year is always computed from
//   the confirmed escalation rule — never hand-typed.
//
// Every function below is pure — no I/O, no state.

interface BaseContract {
  id: string;
  playerName: string;
  position: string;
  team: string; // team slug, see data/teams.ts
  taxiYears?: number[];
  irYears?: number[];
}

export interface ImportedContract extends BaseContract {
  kind: 'imported';
  yearSalaries: Record<number, number>;
}

export interface FormulaContract extends BaseContract {
  kind: 'formula';
  baseSalary: number; // salary in the FIRST year of this contract
  startYear: number;
  lengthYears: number;
}

/**
 * What a cut becomes now — not a deletion. Confirmed rule: for every year
 * that would have remained on the deal, the buyout costs 50% of THAT
 * year's contracted salary, rounded up PER YEAR (not summed then rounded
 * once — a $5 year becomes a $3 buyout year on its own). A buyout always
 * counts against the cap (see countsAgainstCap) but never occupies a
 * roster/taxi/IR spot (see rosterCount) — it's a cap-space line only.
 * Shares the `yearSalaries` shape with ImportedContract on purpose so
 * activeYears/salaryInYear need no separate branch for it.
 */
export interface BuyoutContract extends BaseContract {
  kind: 'buyout';
  yearSalaries: Record<number, number>;
}

export type Contract = ImportedContract | FormulaContract | BuyoutContract;

export const SALARY_CAP = 200;
export const MAX_TAXI_SPOTS = 4;

/** Confirmed rule: escalation tier is fixed by the salary at signing. */
export function annualIncrement(baseSalary: number): number {
  if (baseSalary < 10) return 2;
  if (baseSalary < 30) return 3;
  return 5;
}

/** Every year this contract has a salary on record, sorted ascending. */
export function activeYears(contract: Contract): number[] {
  if (contract.kind === 'imported' || contract.kind === 'buyout') {
    return Object.keys(contract.yearSalaries)
      .map(Number)
      .sort((a, b) => a - b);
  }
  const years: number[] = [];
  for (let i = 0; i < contract.lengthYears; i++) years.push(contract.startYear + i);
  return years;
}

export function endYear(contract: Contract): number {
  const years = activeYears(contract);
  return years[years.length - 1];
}

export function startYear(contract: Contract): number {
  const years = activeYears(contract);
  return years[0];
}

/** The salary in the final year on record. */
export function finalYearSalary(contract: Contract): number | null {
  return salaryInYear(contract, endYear(contract));
}

/**
 * How many consecutive years (ending at the contract's last year) the
 * player has been paid the SAME rate. A jump in salary marks a renewal —
 * this counts only the years since the most recent one.
 */
export function yearsAtFinalRate(contract: Contract): number {
  const years = activeYears(contract);
  if (years.length === 0) return 0;
  const final = salaryInYear(contract, years[years.length - 1]);
  let count = 0;
  for (let i = years.length - 1; i >= 0; i--) {
    const isConsecutive = i === years.length - 1 || years[i] === years[i + 1] - 1;
    if (!isConsecutive) break;
    if (salaryInYear(contract, years[i]) !== final) break;
    count++;
  }
  return count;
}

/**
 * Resign-cost projection: final rate + (that rate's confirmed escalation
 * increment × years spent at that rate). This is NOT a market-value
 * forecast — real re-sign price is market value at the time, which isn't
 * in this dataset. It's a consistent, rule-based anchor: what the same
 * rate would look like if it kept escalating for as long as it's already
 * been flat.
 */
export function projectedResignCost(contract: Contract): number | null {
  const final = finalYearSalary(contract);
  if (final == null) return null;
  const n = yearsAtFinalRate(contract);
  return final + annualIncrement(final) * n;
}

/**
 * Salary in a given year. Returns null if the contract has no salary on
 * record for that year (expired, not started, or simply not entered).
 */
export function salaryInYear(contract: Contract, year: number): number | null {
  if (contract.kind === 'imported' || contract.kind === 'buyout') {
    return contract.yearSalaries[year] ?? null;
  }
  const yearsIn = year - contract.startYear;
  if (yearsIn < 0 || yearsIn >= contract.lengthYears) return null;
  return contract.baseSalary + annualIncrement(contract.baseSalary) * yearsIn;
}

export function yearsRemaining(contract: Contract, asOfYear: number): number {
  if (salaryInYear(contract, asOfYear) == null) return 0;
  return Math.max(0, endYear(contract) - asOfYear);
}

/**
 * Confirmed rule: a cut is a buyout, not a deletion. For every year that
 * would have remained on the deal (cutYear through the contract's own
 * end year), the buyout owes 50% of THAT year's contracted salary,
 * rounded up separately for each year — not summed first and rounded
 * once. Example: a $5 year becomes a $3 buyout year on its own, not
 * folded into one lump total. This is the schedule a cut actually
 * produces (see App.tsx's cutContract/confirmCut, which turn a
 * contract into a BuyoutContract using exactly this map).
 */
export function buyoutScheduleFromCut(contract: Contract, cutYear: number): Record<number, number> {
  const schedule: Record<number, number> = {};
  const end = endYear(contract);
  for (let y = cutYear; y <= end; y++) {
    const salary = salaryInYear(contract, y);
    if (salary == null) continue;
    schedule[y] = Math.ceil(salary * 0.5);
  }
  return schedule;
}

/** Total buyout cost across every remaining year, for the "if cut now" preview column. */
export function cutPenalty(contract: Contract, cutYear: number): number {
  const schedule = buyoutScheduleFromCut(contract, cutYear);
  return Object.values(schedule).reduce((sum, v) => sum + v, 0);
}

export function isTaxi(contract: Contract, year: number): boolean {
  return contract.taxiYears?.includes(year) ?? false;
}

export function isIR(contract: Contract, year: number): boolean {
  return contract.irYears?.includes(year) ?? false;
}

/** Confirmed rule: taxi squad and IR contracts do NOT count against the cap. */
export function countsAgainstCap(contract: Contract, year: number): boolean {
  return !isTaxi(contract, year) && !isIR(contract, year);
}

export function teamCapUsed(contracts: Contract[], year: number): number {
  return contracts.reduce((sum, c) => {
    if (!countsAgainstCap(c, year)) return sum;
    return sum + (salaryInYear(c, year) ?? 0);
  }, 0);
}

export function teamCapSpace(contracts: Contract[], year: number, capLimit = SALARY_CAP): number {
  return capLimit - teamCapUsed(contracts, year);
}

export function contractsForTeam(contracts: Contract[], teamSlug: string): Contract[] {
  return contracts.filter((c) => c.team === teamSlug);
}

/** Confirmed rule: a buyout is a cap-hit-only line — it never occupies a roster spot. */
export function isBuyout(contract: Contract): contract is BuyoutContract {
  return contract.kind === 'buyout';
}

export function rosterCount(contracts: Contract[], year: number): number {
  return contracts.filter((c) => !isBuyout(c) && salaryInYear(c, year) != null && countsAgainstCap(c, year)).length;
}

export function taxiCount(contracts: Contract[], year: number): number {
  return contracts.filter((c) => isTaxi(c, year)).length;
}

export function irCount(contracts: Contract[], year: number): number {
  return contracts.filter((c) => isIR(c, year)).length;
}
