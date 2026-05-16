/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { FunctionDeclaration, Part } from '@google/genai';
import {
  convertToAnthropicTools,
  toAnthropicInputSchema,
  partsToToolResultContent,
  responsePartsToToolResultContent,
  truncateToolOutput,
} from './anthropic-tools.js';
import { ANTHROPIC_TOOL_RESULT_MAX_CHARS } from './types.js';

describe('toAnthropicInputSchema', () => {
  it('passes through parametersJsonSchema near-identity', () => {
    const decl: FunctionDeclaration = {
      name: 'read_file',
      description: 'reads a file',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          absolute_path: { type: 'string', description: 'path' },
          start_line: { type: 'integer', minimum: 1 },
        },
        required: ['absolute_path'],
      },
    };
    const out = toAnthropicInputSchema(decl);
    expect(out.type).toBe('object');
    expect(out['properties']).toEqual({
      absolute_path: { type: 'string', description: 'path' },
      start_line: { type: 'integer', minimum: 1 },
    });
    expect(out['required']).toEqual(['absolute_path']);
  });

  it('strips Gemini-only propertyOrdering extension', () => {
    const decl: FunctionDeclaration = {
      name: 'x',
      parametersJsonSchema: {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        propertyOrdering: ['b', 'a'],
      } as unknown as Record<string, unknown>,
    };
    const out = toAnthropicInputSchema(decl);
    expect(out).not.toHaveProperty('propertyOrdering');
    expect(out['properties']).toEqual({
      a: { type: 'string' },
      b: { type: 'string' },
    });
  });

  it('coerces non-object root to permissive object schema', () => {
    const decl: FunctionDeclaration = {
      name: 'weird',
      parametersJsonSchema: {
        type: 'array',
        items: { type: 'string' },
      } as unknown as Record<string, unknown>,
    };
    const out = toAnthropicInputSchema(decl);
    expect(out).toEqual({ type: 'object', properties: {} });
  });

  it('falls back to parameters when parametersJsonSchema is absent', () => {
    const decl: FunctionDeclaration = {
      name: 'legacy',
      parameters: {
        type: 'object',
        properties: { foo: { type: 'string' } },
      } as unknown as FunctionDeclaration['parameters'],
    };
    const out = toAnthropicInputSchema(decl);
    expect(out['properties']).toEqual({ foo: { type: 'string' } });
  });

  it('returns permissive fallback when no schema is set', () => {
    const decl: FunctionDeclaration = { name: 'no-schema' };
    expect(toAnthropicInputSchema(decl)).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('convertToAnthropicTools', () => {
  it('produces tools with name, description, and input_schema', () => {
    const tools = convertToAnthropicTools([
      {
        name: 'a',
        description: 'A tool',
        parametersJsonSchema: { type: 'object', properties: {} },
      },
      {
        name: 'b',
        // No description (FunctionDeclaration.description is optional).
        parametersJsonSchema: { type: 'object', properties: {} },
      },
    ]);
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      name: 'a',
      description: 'A tool',
      input_schema: { type: 'object', properties: {} },
    });
    expect(tools[1].description).toBe('');
  });

  it('skips declarations missing a name', () => {
    const tools = convertToAnthropicTools([
      { description: 'no name' } as unknown as FunctionDeclaration,
      { name: 'ok' },
    ]);
    expect(tools.map((t) => t.name)).toEqual(['ok']);
  });
});

describe('partsToToolResultContent', () => {
  it('renders text parts directly', () => {
    expect(partsToToolResultContent([{ text: 'hello' }])).toBe('hello');
    expect(partsToToolResultContent('plain string')).toBe('plain string');
  });

  it('renders binary inlineData with a verbose placeholder', () => {
    const png: Part = {
      inlineData: {
        mimeType: 'image/png',
        // 12 KB of base64 ≈ 9 KB raw.
        data: 'A'.repeat(12 * 1024),
      },
    };
    const out = partsToToolResultContent([png]);
    expect(out).toMatch(/\[Image: image\/png/);
    expect(out.length).toBeLessThan(100);
  });
});

describe('responsePartsToToolResultContent', () => {
  it('extracts functionResponse.response.output', () => {
    const parts: Part[] = [
      {
        functionResponse: {
          id: 'c1',
          name: 'read_file',
          response: { output: 'file contents here' },
        },
      },
    ];
    expect(responsePartsToToolResultContent(parts)).toBe('file contents here');
  });

  it('joins output + sibling binary placeholder', () => {
    const parts: Part[] = [
      {
        functionResponse: {
          id: 'c1',
          name: 'read_file',
          response: { output: 'header' },
        },
      },
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: 'AAAA',
        },
      },
    ];
    const out = responsePartsToToolResultContent(parts);
    expect(out).toContain('header');
    expect(out).toMatch(/\[Image: image\/jpeg/);
  });

  it('renders nested response.parts (multimodal-supported model shape)', () => {
    // The Gemini SDK's `FunctionResponse` type doesn't officially declare
    // a `parts` field, but multimodal-capable models nest binary parts
    // there. Build the part via record-shaped casting.
    const fr: Record<string, unknown> = {
      id: 'c1',
      name: 'read_file',
      response: { output: 'description' },
      parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
    };
    const parts = [{ functionResponse: fr } as unknown as Part];
    const out = responsePartsToToolResultContent(parts);
    expect(out).toContain('description');
    expect(out).toMatch(/\[Image: image\/png/);
  });

  it('falls through to verbose partToString for unexpected shapes', () => {
    const parts: Part[] = [{ text: 'fallback text' }];
    expect(responsePartsToToolResultContent(parts)).toBe('fallback text');
  });

  it('returns empty string for empty input', () => {
    expect(responsePartsToToolResultContent([])).toBe('');
  });
});

describe('truncateToolOutput', () => {
  it('passes through short strings unchanged', () => {
    expect(truncateToolOutput('short')).toBe('short');
  });

  it('truncates and appends a refine hint', () => {
    const big = 'a'.repeat(ANTHROPIC_TOOL_RESULT_MAX_CHARS + 1000);
    const out = truncateToolOutput(big);
    expect(out.startsWith('a'.repeat(ANTHROPIC_TOOL_RESULT_MAX_CHARS))).toBe(
      true,
    );
    expect(out).toMatch(/truncated 1000 chars/);
    expect(out).toMatch(/Refine your call/);
  });

  it('handles exactly-at-cap inputs without truncation', () => {
    const exact = 'b'.repeat(ANTHROPIC_TOOL_RESULT_MAX_CHARS);
    expect(truncateToolOutput(exact)).toBe(exact);
  });
});
