import type { VercelRequest, VercelResponse } from '@vercel/node';
import mergeNewSeedContracts from './_lib/admin-merge-new-seed-contracts.js';
import restoreSeedData from './_lib/admin-restore-seed-data.js';
import repairTaxiIr from './_lib/admin-repair-taxi-ir.js';

/**
 * One serverless function for the maintenance endpoints (Hobby plan caps
 * a deployment at 12 functions). Old URLs still work via vercel.json
 * rewrites: /api/restore-seed-data, /api/merge-new-seed-contracts,
 * /api/repair-taxi-ir → /api/admin?action=…
 */
const ACTIONS: Record<string, (req: VercelRequest, res: VercelResponse) => unknown> = {
  'merge-new-seed-contracts': mergeNewSeedContracts,
  'restore-seed-data': restoreSeedData,
  'repair-taxi-ir': repairTaxiIr,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = String(req.query.action ?? '');
  const fn = ACTIONS[action];
  if (!fn) return res.status(400).json({ error: `Unknown action. Use one of: ${Object.keys(ACTIONS).join(', ')}` });
  return fn(req, res);
}
