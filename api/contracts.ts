import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAllContracts, saveAllContracts } from './_lib/store.js';
import { checkCommissionerPassword } from './_lib/auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    const contracts = await getAllContracts();
    return res.status(200).json({ contracts });
  }

  if (req.method === 'PUT') {
    if (!checkCommissionerPassword(req)) {
      return res.status(401).json({ error: 'Wrong or missing commissioner password' });
    }
    const { contracts } = req.body ?? {};
    if (!Array.isArray(contracts)) {
      return res.status(400).json({ error: 'Body must be { contracts: Contract[] }' });
    }
    try {
      const saved = await saveAllContracts(contracts);
      return res.status(200).json({ contracts: saved });
    } catch (err: any) {
      return res.status(500).json({
        error: `Save failed: ${err?.message}. This usually means REDIS_URL isn't set on the server — check the Environment Variables tab in your Vercel project.`,
      });
    }
  }

  res.setHeader('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'Method not allowed' });
}
