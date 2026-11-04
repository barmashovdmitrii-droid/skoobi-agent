// Stable compatibility entry for the existing launch agent and forced SSH RPC.
// The versioned worker owns parsing and execution; importing it alone does not run.
import {main} from '../ops/peer/skoobi-peer-worker.mjs';
await main().catch(()=>{
  console.error('Peer operation failed; inspect private configuration and job state.');
  process.exitCode=1;
});
