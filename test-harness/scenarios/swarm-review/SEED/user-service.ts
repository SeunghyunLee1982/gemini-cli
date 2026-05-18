/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';

export interface User {
  id: string;
  name: string;
  email: string;
  groupId: string;
}

export type DbHandle = {
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  all: () => Promise<User[]>;
};

const bus = new EventEmitter();

/** SECURITY: string-concatenated SQL. */
export async function findUserByEmail(
  db: DbHandle,
  email: string,
): Promise<User | null> {
  const rows = (await db.query(
    `SELECT * FROM users WHERE email = '${email}' LIMIT 1`,
  )) as User[];
  return rows[0] ?? null;
}

/** CORRECTNESS: error swallowed; caller cannot distinguish "no user" from "DB down". */
export async function lookupUser(
  db: DbHandle,
  id: string,
): Promise<User | null> {
  try {
    const rows = (await db.query('SELECT * FROM users WHERE id = ? LIMIT 1', [
      id,
    ])) as User[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/** LEAK: listener registered, never removed on disconnect. */
export function subscribe(
  channel: string,
  handler: (msg: unknown) => void,
): { disconnect: () => void } {
  bus.on(channel, handler);
  return {
    disconnect: () => {
      // forgot to bus.off(channel, handler)
    },
  };
}

/** PERFORMANCE: pulls all users, filters in JS instead of pushing WHERE to DB. */
export async function usersInGroup(
  db: DbHandle,
  groupId: string,
): Promise<User[]> {
  const all = await db.all();
  return all.filter((u) => u.groupId === groupId);
}
