/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Re-exports for the persistent agent swarm primitive.
 *
 * v1.0 surface. See `design-loop/swarm-design.md` for the locked v1.0
 * design and `CLAUDE.md` (Swarm v1.0 section) for usage docs.
 */

export * from './types.js';
export { SwarmSession, type SwarmSessionParams } from './swarm-session.js';
export { SwarmManager, type SwarmActivityEvent } from './swarm-manager.js';
export {
  SwarmTool,
  SwarmInvocation,
  type SwarmActionParams,
  SWARM_TOOL_NAME,
  SWARM_TOOL_DISPLAY_NAME,
} from './swarm-tool.js';
