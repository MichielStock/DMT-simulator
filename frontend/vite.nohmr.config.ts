// Dev server without HMR (captures must not be reloaded mid-run by file edits). Used by the
// integration agent for galleries; `npx vite --config vite.nohmr.config.ts`.
import base from './vite.config';
export default { ...base, server: { ...(base as any).server, hmr: false } };
