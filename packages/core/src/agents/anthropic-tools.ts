/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { FunctionDeclaration, Part, PartListUnion } from '@google/genai';
import { partToString } from '../utils/partUtils.js';
import { ANTHROPIC_TOOL_RESULT_MAX_CHARS } from './types.js';

/**
 * Helpers that bridge between Gemini-style tool declarations / results and
 * the Anthropic Messages API tool-use schema.
 *
 * Conventions:
 * - The Anthropic Messages API accepts JSON Schema 2020-12 natively, so the
 *   conversion from a `FunctionDeclaration.parametersJsonSchema` is mostly an
 *   identity pass: strip Gemini-only extensions (`propertyOrdering`), enforce
 *   `type: 'object'`, and hand the result through unchanged.
 * - `read_file` on a binary (PNG, PDF, audio) yields a `Part` with
 *   `inlineData` rather than text. `partToString({ verbose: true })`
 *   renders a placeholder like `[Image: image/png, 12 KB]` so Claude sees
 *   *something*, not the empty string the non-verbose path would emit.
 * - Tool-result content is capped at {@link ANTHROPIC_TOOL_RESULT_MAX_CHARS}
 *   to prevent a single huge read from eating the rest of the sub-agent's
 *   context window. The truncation suffix nudges Claude to refine its next
 *   call rather than re-read the same file.
 */

const NON_OBJECT_FALLBACK_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {},
};

/**
 * Converts a single `FunctionDeclaration` to an Anthropic `Tool.input_schema`.
 *
 * Reads `parametersJsonSchema` (raw JSON Schema 2020-12, which is what every
 * core/MCP tool actually populates) in preference to OpenAPI-flavored
 * `parameters`. Drops `propertyOrdering` (Gemini-only extension) and coerces
 * non-object root schemas to a permissive `{ type: 'object', properties: {} }`
 * because Anthropic requires `type: 'object'` at the root.
 */
export function toAnthropicInputSchema(
  decl: FunctionDeclaration,
): Anthropic.Tool.InputSchema {
  const raw = decl.parametersJsonSchema ?? decl.parameters;
  if (raw === undefined || raw === null) {
    return NON_OBJECT_FALLBACK_SCHEMA;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return NON_OBJECT_FALLBACK_SCHEMA;
  }
  // `raw` is at this point narrowed to a non-array object. `parametersJsonSchema`
  // is typed `unknown` upstream; copy into a fresh record so we can safely
  // strip the Gemini-only `propertyOrdering` extension.
  const schema: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'propertyOrdering') continue;
    schema[k] = v;
  }
  if (schema['type'] !== 'object') {
    return NON_OBJECT_FALLBACK_SCHEMA;
  }
  // The caller has narrowed `type` to the literal 'object'; everything else
  // is permissive `unknown`-valued, which matches the SDK's `InputSchema`
  // index signature.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return schema as Anthropic.Tool.InputSchema;
}

/**
 * Converts an array of Gemini `FunctionDeclaration`s into Anthropic `Tool`s.
 * Pure data: the caller is responsible for sourcing the declarations from the
 * appropriate (isolated) tool registry.
 */
export function convertToAnthropicTools(
  declarations: FunctionDeclaration[],
): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  for (const decl of declarations) {
    if (!decl.name) continue;
    tools.push({
      name: decl.name,
      description: decl.description ?? '',
      input_schema: toAnthropicInputSchema(decl),
    });
  }
  return tools;
}

/**
 * Renders the `llmContent` of a tool result into a single string suitable for
 * Anthropic's `tool_result.content`. Uses verbose `partToString` so binary
 * Parts (images, audio, files) yield a labelled placeholder instead of the
 * empty string.
 */
export function partsToToolResultContent(parts: PartListUnion): string {
  return partToString(parts, { verbose: true });
}

/**
 * Renders `ToolCallResponseInfo.responseParts` (post-`convertToFunctionResponse`)
 * into a single string for Anthropic. This expects the scheduler-produced
 * shape, which is:
 *
 * - `responseParts[0]` is a `{ functionResponse: { response: { output? } } }`
 *   wrapper produced by `convertToFunctionResponse`. We unwrap and use
 *   `response.output` (a string) when present.
 * - Sibling parts may be raw `inlineData` / `fileData` for models that don't
 *   support multimodal function responses. Render those via verbose
 *   `partToString` so Claude at least sees a labelled placeholder.
 *
 * If unwrapping fails (unexpected shape), falls back to verbose `partToString`
 * over the whole array.
 */
export function responsePartsToToolResultContent(parts: Part[]): string {
  if (parts.length === 0) return '';

  const segments: string[] = [];

  const first = parts[0];
  const fr = first?.functionResponse;
  if (fr && fr.response && typeof fr.response === 'object') {
    const resp: Record<string, unknown> = fr.response;
    const output = resp['output'];
    if (typeof output === 'string') segments.push(output);
    const error = resp['error'];
    if (typeof error === 'string') segments.push(error);

    // Nested binary parts: `{ ...response, parts: Part[] }` shape used by
    // multimodal-capable models. The Gemini SDK `FunctionResponse` type
    // does not officially declare a `parts` field, so we read it
    // defensively via an index lookup.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const maybeParts = (fr as unknown as { parts?: unknown }).parts;
    if (Array.isArray(maybeParts)) {
      for (const np of maybeParts) {
        if (typeof np !== 'object' || np === null) continue;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const rendered = partToString(np as Part, { verbose: true });
        if (rendered) segments.push(rendered);
      }
    }
  } else {
    // No function-response wrapper. Fall back to verbose rendering.
    segments.push(partToString(first, { verbose: true }));
  }

  for (let i = 1; i < parts.length; i++) {
    const rendered = partToString(parts[i], { verbose: true });
    if (rendered) segments.push(rendered);
  }

  return segments.filter((s) => s.length > 0).join('\n\n');
}

/**
 * Caps a tool-result string at {@link ANTHROPIC_TOOL_RESULT_MAX_CHARS} and
 * appends a soft "refine your call" hint when truncated. Returns the input
 * unchanged when within the cap.
 *
 * Length is measured in JS string-length (UTF-16 code units). Close enough
 * to chars for the purpose of a soft hint, and avoids the cost of a real
 * `Buffer.byteLength` UTF-8 encoding for every tool result.
 */
export function truncateToolOutput(text: string): string {
  if (text.length <= ANTHROPIC_TOOL_RESULT_MAX_CHARS) {
    return text;
  }
  const truncated = text.slice(0, ANTHROPIC_TOOL_RESULT_MAX_CHARS);
  const dropped = text.length - ANTHROPIC_TOOL_RESULT_MAX_CHARS;
  return (
    truncated +
    `\n\n[... truncated ${dropped} chars. Refine your call (narrower glob, ` +
    `smaller line range, more specific grep).]`
  );
}
