import { describe, expect, test } from "bun:test";
import { callback } from "../src/callback.js";
import { MAX_BODY_BYTES, randomToken, sha256Hex } from "../src/protocol.js";
import type { Hook, Sql } from "../src/provider.js";
import { findRun } from "../src/store.js";
import { memorySql, seedRun } from "./sql.js";

const URL_ = "https://executor.example/api/webhooks/app_x/whk_y";
type HandleInput = Parameters<typeof callback.handle>[1];
type RegisterInput = Parameters<typeof callback.register>[1];
type UnregisterInput = Parameters<typeof callback.unregister>[1];

const ctx = (sql: Sql) => ({ sql }) as unknown as Hook;
const post = (sql: Sql, init: RequestInit, account = "acc_a") =>
  callback.handle(ctx(sql), {
    request: new Request(URL_, { method: "POST", ...init }),
    account: { id: account },
  } as unknown as HandleInput);
const json = (body: unknown, token?: string): RequestInit => ({
  body: JSON.stringify(body),
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
});

/** A pending run whose token the caller knows, as dispatch leaves it. */
async function pendingRun(sql: Sql, id: string, account = "acc_a") {
  const token = randomToken();
  seedRun(sql, { id, account, tokenHash: await sha256Hex(token) });
  return token;
}

describe("the callback webhook", () => {
  test("records a report that carries the run's token", async () => {
    const sql = memorySql();
    const token = await pendingRun(sql, "run_1");
    const response = await post(sql, json({ run_id: "run_1", status: "ok", result: "42" }, token));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, run_id: "run_1", outcome: "recorded" });
    expect(findRun(sql, "acc_a", "run_1")?.result).toBe("42");
  });

  test("accepts the token in the body for a client that cannot set headers", async () => {
    const sql = memorySql();
    const token = await pendingRun(sql, "run_1");
    const response = await post(sql, json({ run_id: "run_1", status: "ok", result: "42", token }));
    expect(response.status).toBe(200);
  });

  test("refuses a report without a token", async () => {
    const sql = memorySql();
    await pendingRun(sql, "run_1");
    const response = await post(sql, json({ run_id: "run_1", status: "ok", result: "42" }));
    expect(response.status).toBe(401);
    expect(findRun(sql, "acc_a", "run_1")?.status).toBe("pending");
  });

  test("refuses a wrong token and an unknown run with the same answer", async () => {
    const sql = memorySql();
    await pendingRun(sql, "run_1");
    const wrong = await post(
      sql,
      json({ run_id: "run_1", status: "ok", result: "x" }, randomToken()),
    );
    const unknown = await post(
      sql,
      json({ run_id: "run_nope", status: "ok", result: "x" }, randomToken()),
    );
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());
    expect(findRun(sql, "acc_a", "run_1")?.status).toBe("pending");
  });

  test("one run's token cannot complete another run", async () => {
    const sql = memorySql();
    const tokenA = await pendingRun(sql, "run_a");
    await pendingRun(sql, "run_b");
    const response = await post(sql, json({ run_id: "run_b", status: "ok", result: "x" }, tokenA));
    expect(response.status).toBe(401);
    expect(findRun(sql, "acc_a", "run_b")?.status).toBe("pending");
  });

  test("a token is useless on another account's callback URL", async () => {
    const sql = memorySql();
    const token = await pendingRun(sql, "run_1", "acc_a");
    const response = await post(
      sql,
      json({ run_id: "run_1", status: "ok", result: "x" }, token),
      "acc_b",
    );
    expect(response.status).toBe(401);
    expect(findRun(sql, "acc_a", "run_1")?.status).toBe("pending");
  });

  test("replaying a report is answered as a duplicate and changes nothing", async () => {
    const sql = memorySql();
    const token = await pendingRun(sql, "run_1");
    await post(sql, json({ run_id: "run_1", status: "ok", result: "first" }, token));
    const replay = await post(
      sql,
      json({ run_id: "run_1", status: "ok", result: "second" }, token),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ outcome: "duplicate" });
    expect(findRun(sql, "acc_a", "run_1")?.result).toBe("first");
  });

  test("answers 400 for a body that is not JSON or not a valid report", async () => {
    const sql = memorySql();
    const token = await pendingRun(sql, "run_1");
    expect((await post(sql, { body: "not json" })).status).toBe(400);
    expect((await post(sql, json({ run_id: "run_1", status: "maybe" }, token))).status).toBe(400);
    const noResult = await post(sql, json({ run_id: "run_1", status: "ok" }, token));
    expect(noResult.status).toBe(400);
    expect(await noResult.json()).toEqual({ error: "A dispatch run needs a result string." });
    expect(findRun(sql, "acc_a", "run_1")?.status).toBe("pending");
  });

  test("answers 413 for a body over the limit, before parsing it", async () => {
    const response = await post(memorySql(), { body: "x".repeat(MAX_BODY_BYTES + 1) });
    expect(response.status).toBe(413);
  });

  test("answers 405 for anything but POST", async () => {
    const response = await callback.handle(ctx(memorySql()), {
      request: new Request(URL_),
      account: { id: "acc_a" },
    } as unknown as HandleInput);
    expect(response.status).toBe(405);
  });
});

describe("callback registration", () => {
  const route = (sql: Sql) =>
    sql
      .exec<{ subscription: string; callback_url: string; active: number }>(
        "SELECT subscription, callback_url, active FROM routes WHERE account_id = ?",
        "acc_a",
      )
      .toArray();
  const register = (sql: Sql, subscriptionId: string, callbackUrl: string) =>
    callback.register(ctx(sql), {
      account: { id: "acc_a" },
      subscriptionId,
      callbackUrl,
    } as unknown as RegisterInput);

  test("a redeploy replaces the callback URL for the account", async () => {
    const sql = memorySql();
    await register(sql, "whk_1", "https://executor.example/api/webhooks/app_x/whk_1");
    await register(sql, "whk_2", "https://executor.example/api/webhooks/app_x/whk_2");
    expect(route(sql)).toEqual([
      {
        subscription: "whk_2",
        callback_url: "https://executor.example/api/webhooks/app_x/whk_2",
        active: 1,
      },
    ]);
  });

  test("removing the old subscription after a redeploy leaves the new route active", async () => {
    const sql = memorySql();
    await register(sql, "whk_1", "https://executor.example/api/webhooks/app_x/whk_1");
    await register(sql, "whk_2", "https://executor.example/api/webhooks/app_x/whk_2");
    await callback.unregister(ctx(sql), { subscriptionId: "whk_1" } as unknown as UnregisterInput);
    expect(route(sql)[0]?.active).toBe(1);
  });

  test("removing the current subscription deactivates the route", async () => {
    const sql = memorySql();
    await register(sql, "whk_1", "https://executor.example/api/webhooks/app_x/whk_1");
    await callback.unregister(ctx(sql), { subscriptionId: "whk_1" } as unknown as UnregisterInput);
    expect(route(sql)[0]?.active).toBe(0);
  });
});
