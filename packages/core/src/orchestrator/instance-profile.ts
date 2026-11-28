// The instance profile (owner-specific values of this installation) lives in
// the @skoobi/shared package. This module keeps `./instance-profile.js`
// importable from the orchestrator, like ./env.js and ./logger.js. Code that
// exists as an exact copy in agent/runner imports this name on both sides:
// the runner has its own module of the same name (see
// agent/runner/src/instance-profile.ts).
export * from '@skoobi/shared/instance-profile';
