/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export function add(a: number, b: number): number {
  return a + b;
}

export function sub(a: number, b: number): number {
  return a - b;
}

export function mul(a: number, b: number): number {
  return a * b;
}

export function div(a: number, b: number): number {
  if (b === 0) {
    throw new Error('division by zero');
  }
  return a / b;
}

export function mean(values: number[]): number {
  if (values.length === 0) {
    throw new Error('mean of empty array');
  }
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

export function percentile(p: number, values: number[]): number {
  if (values.length === 0) throw new Error('percentile of empty array');
  if (p < 0 || p > 100) throw new Error('percentile out of range');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
