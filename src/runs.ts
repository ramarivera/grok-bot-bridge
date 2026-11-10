import { array, boolean, mutation, number, object, query, string } from "apps";
import {
  type Action,
  buildPayload,
  MAX_PROMPT_CHARS,
  matchTeammate,
  parseCallback,
  randomToken,
  routineUrl,
  sha256Hex,
  timeoutMinutes,
} from "./protocol.js";
import type { Mut, Qry } from "./provider.js";
import { complete, findRun, RUN_COLUMNS, type RunRow, roster, view } from "./store.js";

/** Reserve the run, POST the routine webhook, then mark it pending. Nothing rolls back the POST. */
async function send(
  ctx: Mut,
  run: { action: Action; target?: string; prompt?: string; minutes: number },
) {
  const account = ctx.user.accounts.router;
  const route = ctx.sql
    .exec<{ callback_url: string }>(
      "SELECT callback_url FROM routes WHERE account_id = ? AND active = 1",
      account.id,
    )
    .toArray()[0];
  if (!route)
    throw new Error(
      "The callback webhook isn't registered for this account yet. Open the app's Webhooks tab and check the `callback` subscription.",
    );
  const url = routineUrl(account.fields.url);
  const runId = `run_${crypto.randomUUID()}`;
  const token = randomToken();
  const now = Date.now();
  ctx.sql.exec(
    "INSERT INTO runs (id, account_id, action, target, prompt, status, token_hash, created_at, deadline_at) VALUES (?, ?, ?, ?, ?, 'sending', ?, ?, ?)",
    runId,
    account.id,
    run.action,
    run.target ?? null,
    run.prompt ?? null,
    await sha256Hex(token),
    now,
    now + run.minutes * 60_000,
  );
  const fail = (error: string) => {
    ctx.sql.exec(
      "UPDATE runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status = 'sending'",
      error,
      Date.now(),
      runId,
    );
    return { runId, status: "failed" as const, error };
  };
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.fields.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildPayload({ ...run, runId, callbackUrl: route.callback_url, token })),
      redirect: "manual",
      signal: ctx.signal,
    });
  } catch (error) {
    return fail(
      `Could not reach the routine webhook: ${error instanceof Error ? error.message : "network error"}`,
    );
  }
  // Grok Bot documents 200 as "run started" and any other answer as "no run started".
  if (response.status !== 200)
    return fail(
      `Grok Bot answered HTTP ${response.status}, so no run started. Check that the routine isn't paused and the linked key is current.`,
    );
  // The report can land before this line; only a run still marked sending becomes pending.
  ctx.sql.exec("UPDATE runs SET status = 'pending' WHERE id = ? AND status = 'sending'", runId);
  return { runId, status: "pending" as const, error: null };
}

export const dispatch = mutation(
  {
    description:
      "Send a prompt to one Grok Bot teammate through the router bot. Returns a runId at once; the teammate's answer arrives later, so read it with `result`. Check `teammates` first to pick the target.",
    input: object({
      target: string({ minLength: 1 }),
      prompt: string({ minLength: 1 }),
      timeoutMinutes: number().optional(),
      skipRosterCheck: boolean().optional(),
    }),
  },
  async (ctx: Mut, input) => {
    if (input.prompt.length > MAX_PROMPT_CHARS)
      throw new Error(`prompt is longer than ${MAX_PROMPT_CHARS} characters.`);
    const minutes = timeoutMinutes(input.timeoutMinutes);
    const names = roster(ctx.sql, ctx.user.accounts.router.id).map((mate) => mate.name);
    let target = input.target.trim();
    // An empty roster means it was never refreshed; the router bot still checks the name itself.
    if (names.length > 0 && !input.skipRosterCheck) {
      const known = matchTeammate(names, target);
      if (!known)
        throw new Error(
          `No teammate named "${target}" in the cached roster (${names.join(", ")}). Run refreshTeammates if the roster is stale, or pass skipRosterCheck.`,
        );
      target = known;
    }
    return send(ctx, { action: "dispatch", target, prompt: input.prompt, minutes });
  },
);

export const refreshTeammates = mutation(
  {
    description:
      "Ask the router bot to report the current teammates. Returns a runId; once that run is done, `teammates` serves the new roster.",
    input: object({}),
  },
  async (ctx: Mut) => send(ctx, { action: "roster", minutes: 15 }),
);

export const result = query(
  {
    description:
      "Read one run: pending, done (with the teammate's result), error (the router reported a problem), failed (Grok Bot never started the run) or timed_out (no report before the deadline; the answer may still be in the bot's chat).",
    input: object({ runId: string({ minLength: 1 }) }),
  },
  async (ctx: Qry, { runId }) => {
    const row = findRun(ctx.sql, ctx.user.accounts.router.id, runId);
    if (!row) throw new Error(`No run ${runId} for the linked router bot.`);
    return view(row, Date.now());
  },
);

export const runs = query(
  {
    description: "List recent runs for the linked router bot, newest first.",
    input: object({ limit: number().optional() }),
  },
  async (ctx: Qry, { limit }) => {
    const size = Math.min(Math.max(Math.floor(limit ?? 20), 1), 100);
    const now = Date.now();
    return ctx.sql
      .exec<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM runs WHERE account_id = ? ORDER BY created_at DESC LIMIT CAST(? AS INTEGER)`,
        ctx.user.accounts.router.id,
        size,
      )
      .toArray()
      .map((row) => {
        const item = view(row, now);
        // Results can be large; `result` returns the full text for one run.
        return { ...item, result: item.result === null ? null : item.result.slice(0, 280) };
      });
  },
);

export const teammates = query(
  {
    description:
      "The cached roster of Grok Bot teammates: name, description and what each one handles. Instant; it is whatever the last refreshTeammates run reported.",
    input: object({}),
  },
  async (ctx: Qry) => {
    const rows = roster(ctx.sql, ctx.user.accounts.router.id);
    const refreshedAt = rows.reduce((latest, row) => Math.max(latest, row.refreshed_at), 0);
    return {
      teammates: rows.map(({ name, description, handles }) => ({ name, description, handles })),
      refreshedAt: refreshedAt === 0 ? null : new Date(refreshedAt).toISOString(),
      note: rows.length === 0 ? "No roster yet. Run refreshTeammates and read its run." : null,
    };
  },
);

export const report = mutation(
  {
    description:
      "Record a run's outcome. For a router bot that has this app connected as a tool; a bot without it POSTs the run's callback URL instead. status is ok or error.",
    input: object({
      runId: string({ minLength: 1 }),
      status: string(),
      result: string().optional(),
      error: string().optional(),
      roster: array(
        object({
          name: string(),
          description: string().optional(),
          handles: string().optional(),
        }),
      ).optional(),
    }),
  },
  async (ctx: Mut, input) => {
    const parsed = parseCallback({
      run_id: input.runId,
      status: input.status,
      result: input.result,
      error: input.error,
      roster: input.roster,
    });
    const outcome = complete(ctx.sql, ctx.user.accounts.router.id, parsed, Date.now());
    if (outcome.outcome === "invalid") throw new Error(outcome.reason);
    if (outcome.outcome === "unknown")
      throw new Error(`No run ${input.runId} for the linked router bot.`);
    return { runId: input.runId, outcome: outcome.outcome };
  },
);
