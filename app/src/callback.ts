import { object, type Webhook } from "apps";
import {
  bearer,
  type Callback,
  CallbackError,
  MAX_BODY_BYTES,
  parseCallback,
  sameDigest,
  sha256Hex,
} from "./protocol.js";
import type { Hook } from "./provider.js";
import { complete, findRun } from "./store.js";

const Empty = object({});
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// The router bot POSTs each run's outcome here. Grok Bot has no webhook registration API, so
// `register` only records the callback URL Executor assigned; dispatch puts that URL and a
// single-use token in every payload. The token, not Executor's signing secret, authenticates the
// report: the bot never has to hold a long-lived secret in its instructions.
export const callback = {
  account: { user: "router" },
  config: Empty,
  state: Empty,
  async register(ctx, { account, subscriptionId, callbackUrl }) {
    ctx.sql.exec(
      "INSERT INTO routes (account_id, subscription, callback_url, active, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(account_id) DO UPDATE SET subscription = excluded.subscription, callback_url = excluded.callback_url, active = 1, updated_at = excluded.updated_at",
      account.id,
      subscriptionId,
      callbackUrl,
      Date.now(),
    );
    return {};
  },
  async handle(ctx, { request, account }) {
    if (request.method !== "POST") return json(405, { error: "POST only." });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES)
      return json(413, { error: `Body is larger than ${MAX_BODY_BYTES} bytes.` });
    let report: Callback;
    try {
      report = parseCallback(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      return json(400, {
        error: error instanceof CallbackError ? error.message : "Body is not valid JSON.",
      });
    }
    const token = bearer(request.headers.get("authorization")) ?? report.token;
    const run = findRun(ctx.sql, account.id, report.runId);
    // Same answer for an unknown run and a wrong token, so a caller can't probe for run ids.
    if (!token || !run || !sameDigest(await sha256Hex(token), run.token_hash))
      return json(401, { error: "Unknown run or wrong token." });
    const outcome = complete(ctx.sql, account.id, report, Date.now());
    if (outcome.outcome === "invalid") return json(400, { error: outcome.reason });
    return json(200, { ok: true, run_id: report.runId, outcome: outcome.outcome });
  },
  async unregister(ctx, { subscriptionId }) {
    ctx.sql.exec("UPDATE routes SET active = 0 WHERE subscription = ?", subscriptionId);
  },
} satisfies Webhook<Hook, typeof Empty, typeof Empty>;
