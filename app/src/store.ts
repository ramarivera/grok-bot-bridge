import type { Action, Callback, PublicStatus, StoredStatus, Teammate } from "./protocol.js";
import { publicStatus } from "./protocol.js";
import type { Reader, Sql } from "./provider.js";

export type RunRow = {
  id: string;
  action: Action;
  target: string | null;
  status: StoredStatus;
  token_hash: string;
  result: string | null;
  error: string | null;
  webhook_reply: string | null;
  created_at: number;
  deadline_at: number;
  completed_at: number | null;
};

export const RUN_COLUMNS =
  "id, action, target, status, token_hash, result, error, webhook_reply, created_at, deadline_at, completed_at";

export type RunView = {
  runId: string;
  action: Action;
  target: string | null;
  status: PublicStatus;
  result: string | null;
  error: string | null;
  /** What Grok Bot answered when the routine webhook was called: status and the start of the body. */
  webhookReply: string | null;
  createdAt: string;
  completedAt: string | null;
};

export function view(row: RunRow, now: number): RunView {
  return {
    runId: row.id,
    action: row.action,
    target: row.target,
    status: publicStatus(row.status, row.deadline_at, now),
    result: row.result,
    error: row.error,
    webhookReply: row.webhook_reply,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  };
}

export function findRun(sql: Reader, accountId: string, runId: string): RunRow | undefined {
  return sql
    .exec<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE id = ? AND account_id = ?`,
      runId,
      accountId,
    )
    .toArray()[0];
}

export function roster(sql: Reader, accountId: string): (Teammate & { refreshed_at: number })[] {
  return sql
    .exec<Teammate & { refreshed_at: number }>(
      "SELECT name, description, handles, refreshed_at FROM roster WHERE account_id = ? ORDER BY name",
      accountId,
    )
    .toArray();
}

export type Outcome =
  | { outcome: "recorded" | "duplicate" | "unknown" }
  | { outcome: "invalid"; reason: string };

/**
 * Record what the router reported. A run is completed once: a second report for the same run is a
 * duplicate and changes nothing, so a bot that retries its callback can't overwrite a result.
 */
export function complete(sql: Sql, accountId: string, report: Callback, now: number): Outcome {
  return sql.transaction((tx): Outcome => {
    const run = tx
      .exec<Pick<RunRow, "action" | "status">>(
        "SELECT action, status FROM runs WHERE id = ? AND account_id = ?",
        report.runId,
        accountId,
      )
      .toArray()[0];
    if (!run) return { outcome: "unknown" };
    if (run.status !== "pending" && run.status !== "sending") return { outcome: "duplicate" };
    if (report.status === "error") {
      tx.exec(
        "UPDATE runs SET status = 'error', error = ?, completed_at = ? WHERE id = ?",
        report.error ?? "",
        now,
        report.runId,
      );
      return { outcome: "recorded" };
    }
    let result: string;
    if (run.action === "roster") {
      if (!report.roster)
        return { outcome: "invalid", reason: "A roster run needs a roster array." };
      tx.exec("DELETE FROM roster WHERE account_id = ?", accountId);
      for (const mate of report.roster)
        tx.exec(
          "INSERT INTO roster (account_id, name, description, handles, refreshed_at) VALUES (?, ?, ?, ?, ?)",
          accountId,
          mate.name,
          mate.description,
          mate.handles,
          now,
        );
      result = JSON.stringify(report.roster);
    } else {
      if (report.result === undefined)
        return { outcome: "invalid", reason: "A dispatch run needs a result string." };
      result = report.result;
    }
    tx.exec(
      "UPDATE runs SET status = 'done', result = ?, completed_at = ? WHERE id = ?",
      result,
      now,
      report.runId,
    );
    return { outcome: "recorded" };
  });
}
