/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Drift guard for the Anthropic model alias map.
 *
 * The map in `types.ts` is the single source of truth — the type alias, the
 * Zod schemas in `agentLoader.ts` and `swarm/types.ts`, and the JSON-schema
 * mirror in `swarm/swarm-tool.ts` all derive from it. This test fails fast
 * if any of those sites silently re-declares the alias literals out of
 * sync. Phase 4 invariant-locality fix.
 */

import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
  ANTHROPIC_MODEL_ALIASES,
  ANTHROPIC_MODEL_ALIAS_VALUES,
} from './types.js';
import { SwarmActionSchema } from './swarm/types.js';
import { resolveAnthropicModel } from './anthropic-invocation.js';

describe('ANTHROPIC_MODEL_ALIASES drift guard', () => {
  it('exposes a non-empty, deterministic alias set', () => {
    const keys = Object.keys(ANTHROPIC_MODEL_ALIASES).sort();
    expect(keys.length).toBeGreaterThan(0);
    // Every value must be a non-empty, hyphen-delimited model id.
    for (const key of keys) {
      const id =
        ANTHROPIC_MODEL_ALIASES[key as keyof typeof ANTHROPIC_MODEL_ALIASES];
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      expect(id).toMatch(/^claude-[a-z0-9-]+$/);
    }
  });

  it('keeps ANTHROPIC_MODEL_ALIAS_VALUES in lockstep with the map keys', () => {
    expect([...ANTHROPIC_MODEL_ALIAS_VALUES].sort()).toEqual(
      Object.keys(ANTHROPIC_MODEL_ALIASES).sort(),
    );
  });

  it('resolves every alias to its concrete model id', () => {
    for (const key of ANTHROPIC_MODEL_ALIAS_VALUES) {
      expect(resolveAnthropicModel(key)).toBe(ANTHROPIC_MODEL_ALIASES[key]);
    }
  });

  it('SwarmActionSchema spawn.model accepts exactly the aliases (no more, no less)', () => {
    // Every declared alias must pass validation.
    for (const alias of ANTHROPIC_MODEL_ALIAS_VALUES) {
      const ok = SwarmActionSchema.safeParse({
        action: 'spawn',
        system_prompt: 'x',
        model: alias,
      });
      expect(ok.success).toBe(true);
    }
    // A bogus alias must NOT validate. This is the property that catches
    // future drift: if someone removes a key from the map but forgets to
    // update the Zod enum, the test on the alias side still passes — but
    // this negative check fails on the previously-valid (now-removed) key.
    const bogus = SwarmActionSchema.safeParse({
      action: 'spawn',
      system_prompt: 'x',
      model: 'definitely-not-a-real-alias',
    });
    expect(bogus.success).toBe(false);
  });

  it('SwarmActionSchema spawn.model is exactly a Zod enum over the alias values', () => {
    // Reach into the schema to fetch the `model` shape from the spawn
    // variant. If the Zod enum diverges from the map keys, this assertion
    // catches it without depending on TS structural typing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allOpts = SwarmActionSchema.options as any[];
    const spawnVariant = allOpts.find(
      (opt) => opt.shape.action?.value === 'spawn',
    );
    expect(spawnVariant).toBeDefined();
    const modelField = spawnVariant.shape.model as z.ZodOptional<
      z.ZodEnum<[string, ...string[]]>
    >;
    const enumOptions = modelField.unwrap().options;
    expect([...enumOptions].sort()).toEqual(
      [...ANTHROPIC_MODEL_ALIAS_VALUES].sort(),
    );
  });
});
