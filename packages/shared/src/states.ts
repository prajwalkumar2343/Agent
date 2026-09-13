export type RunState =
  | 'received'
  | 'spec'
  | 'checked'
  | 'evidence'
  | 'build'
  | 'reported'
  | 'await_rollout'
  | 'await_ci'
  | 'live'
  | 'monitor'
  | 'done'
  | 'rolled_back'
  | 'failed';
