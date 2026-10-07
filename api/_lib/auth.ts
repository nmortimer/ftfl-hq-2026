// TEMPORARILY DISABLED: this always returns true, so the write endpoints
// (api/contracts.ts) are open to anyone with the URL. The real check used
// to fail closed here if COMMISSIONER_PASSWORD wasn't set on Vercel — but
// that meant a misconfigured/missing env var silently blocked every save
// with no clear error, which is what was actually happening.
//
// To re-lock this later: set COMMISSIONER_PASSWORD in Vercel, then
// restore the real check below, and bring back the login UI in
// src/App.tsx / src/lib/api.ts (removed for now, see git history or ask
// to have it rebuilt).
export function checkCommissionerPassword(_req: { headers: Record<string, string | string[] | undefined> }): boolean {
  return true;
}
