import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "../src/provider.js";

type Binding = string | number | null;
type Cursor<T> = { toArray(): T[]; one(): T };
type MemorySql = {
  exec<T>(query: string, ...bindings: Binding[]): Cursor<T>;
  transaction<T>(work: (tx: MemorySql) => T): T;
};

/**
 * An in-memory stand-in for the app's SQL, built from the real migrations so the tests also prove
 * the schema and the queries agree.
 */
export function memorySql(): Sql {
  const db = new Database(":memory:");
  const migrations = join(import.meta.dir, "..", "migrations");
  for (const file of readdirSync(migrations).sort())
    db.exec(readFileSync(join(migrations, file), "utf8"));
  const api: MemorySql = {
    exec<T>(query: string, ...bindings: Binding[]) {
      const rows = db.query(query).all(...bindings) as T[];
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}.`);
          return rows[0] as T;
        },
      };
    },
    transaction<T>(work: (tx: MemorySql) => T): T {
      db.exec("BEGIN");
      try {
        const value = work(api);
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return api as unknown as Sql;
}

export type SeedRun = {
  id: string;
  account?: string;
  action?: "dispatch" | "roster";
  status?: string;
  tokenHash?: string;
  deadlineAt?: number;
};

export function seedRun(sql: Sql, run: SeedRun): void {
  sql.exec(
    "INSERT INTO runs (id, account_id, action, target, prompt, status, token_hash, created_at, deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    run.id,
    run.account ?? "acc_a",
    run.action ?? "dispatch",
    run.action === "roster" ? null : "Researcher",
    run.action === "roster" ? null : "do the thing",
    run.status ?? "pending",
    run.tokenHash ?? "unused",
    1_000,
    run.deadlineAt ?? 2_000,
  );
}
