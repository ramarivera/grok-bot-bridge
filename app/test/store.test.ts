import { describe, expect, test } from "bun:test";
import { complete, findRun, roster, view } from "../src/store.js";
import { memorySql, seedRun } from "./sql.js";

const ok = (runId: string, result: string) => ({ runId, status: "ok" as const, result });

describe("completing a dispatch", () => {
  test("stores the result word for word and marks the run done", () => {
    const sql = memorySql();
    seedRun(sql, { id: "run_1" });
    expect(complete(sql, "acc_a", ok("run_1", 'line one\n"quoted"'), 5_000)).toEqual({
      outcome: "recorded",
    });
    const run = findRun(sql, "acc_a", "run_1");
    expect(run?.status).toBe("done");
    expect(run?.result).toBe('line one\n"quoted"');
    expect(run?.completed_at).toBe(5_000);
  });

  test("a second report is a duplicate and cannot overwrite the first", () => {
    const sql = memorySql();
    seedRun(sql, { id: "run_1" });
    complete(sql, "acc_a", ok("run_1", "first"), 5_000);
    expect(complete(sql, "acc_a", ok("run_1", "second"), 6_000)).toEqual({ outcome: "duplicate" });
    expect(findRun(sql, "acc_a", "run_1")?.result).toBe("first");
  });

  test("an error report cannot replace a stored result either", () => {
    const sql = memorySql();
    seedRun(sql, { id: "run_1" });
    complete(sql, "acc_a", ok("run_1", "first"), 5_000);
    const report = { runId: "run_1", status: "error" as const, error: "nope" };
    expect(complete(sql, "acc_a", report, 6_000)).toEqual({ outcome: "duplicate" });
    expect(findRun(sql, "acc_a", "run_1")?.status).toBe("done");
  });

  test("a run still marked sending can be completed, because the report can beat the webhook answer", () => {
    const sql = memorySql();
    seedRun(sql, { id: "run_1", status: "sending" });
    expect(complete(sql, "acc_a", ok("run_1", "fast"), 5_000).outcome).toBe("recorded");
  });

  test("a failed run stays failed", () => {
    const sql = memorySql();
    seedRun(sql, { id: "run_1", status: "failed" });
    expect(complete(sql, "acc_a", ok("run_1", "late"), 5_000).outcome).toBe("duplicate");
    expect(findRun(sql, "acc_a", "run_1")?.status).toBe("failed");
  });

  test("an unknown run id is unknown", () => {
    expect(complete(memorySql(), "acc_a", ok("run_missing", "x"), 5_000)).toEqual({
      outcome: "unknown",
    });
  });

  test("another account cannot complete or read the run", () => {
    const sql = memorySql();
    seedRun(sql, { id: "run_1", account: "acc_a" });
    expect(complete(sql, "acc_b", ok("run_1", "stolen"), 5_000)).toEqual({ outcome: "unknown" });
    expect(findRun(sql, "acc_b", "run_1")).toBeUndefined();
    expect(findRun(sql, "acc_a", "run_1")?.status).toBe("pending");
  });

  test("an error report stores the reason", () => {
    const sql = memorySql();
    seedRun(sql, { id: "run_1" });
    const report = { runId: "run_1", status: "error" as const, error: "No bot named Nobody." };
    expect(complete(sql, "acc_a", report, 5_000).outcome).toBe("recorded");
    const run = findRun(sql, "acc_a", "run_1");
    expect(run?.status).toBe("error");
    expect(run?.error).toBe("No bot named Nobody.");
    expect(run?.result).toBeNull();
  });

  test("an ok report without a result is invalid and leaves the run pending", () => {
    const sql = memorySql();
    seedRun(sql, { id: "run_1" });
    const outcome = complete(sql, "acc_a", { runId: "run_1", status: "ok" }, 5_000);
    expect(outcome.outcome).toBe("invalid");
    expect(findRun(sql, "acc_a", "run_1")?.status).toBe("pending");
  });

  test("an empty string is a valid result", () => {
    const sql = memorySql();
    seedRun(sql, { id: "run_1" });
    expect(complete(sql, "acc_a", ok("run_1", ""), 5_000).outcome).toBe("recorded");
    expect(findRun(sql, "acc_a", "run_1")?.result).toBe("");
  });
});

describe("completing a roster run", () => {
  const mates = [
    { name: "Eggbot", description: "designs bots", handles: "new teammates" },
    { name: "Scourer", description: "finds repos", handles: "GitHub hunts" },
  ];

  test("replaces the cached roster for that account only", () => {
    const sql = memorySql();
    seedRun(sql, { id: "run_old", action: "roster" });
    complete(
      sql,
      "acc_a",
      { runId: "run_old", status: "ok", roster: [{ name: "Gone", description: "", handles: "" }] },
      4_000,
    );
    seedRun(sql, { id: "run_b", account: "acc_b", action: "roster" });
    complete(sql, "acc_b", { runId: "run_b", status: "ok", roster: [mates[0]] }, 4_500);

    seedRun(sql, { id: "run_new", action: "roster" });
    expect(
      complete(sql, "acc_a", { runId: "run_new", status: "ok", roster: mates }, 5_000).outcome,
    ).toBe("recorded");

    expect(roster(sql, "acc_a").map((mate) => mate.name)).toEqual(["Eggbot", "Scourer"]);
    expect(roster(sql, "acc_a").every((mate) => mate.refreshed_at === 5_000)).toBe(true);
    expect(roster(sql, "acc_b").map((mate) => mate.name)).toEqual(["Eggbot"]);
    expect(JSON.parse(findRun(sql, "acc_a", "run_new")?.result ?? "null")).toEqual(mates);
  });

  test("an empty roster is valid and clears the cache", () => {
    const sql = memorySql();
    seedRun(sql, { id: "run_1", action: "roster" });
    complete(sql, "acc_a", { runId: "run_1", status: "ok", roster: mates }, 4_000);
    seedRun(sql, { id: "run_2", action: "roster" });
    complete(sql, "acc_a", { runId: "run_2", status: "ok", roster: [] }, 5_000);
    expect(roster(sql, "acc_a")).toEqual([]);
  });

  test("a roster run without a roster is invalid and keeps the old cache", () => {
    const sql = memorySql();
    seedRun(sql, { id: "run_1", action: "roster" });
    complete(sql, "acc_a", { runId: "run_1", status: "ok", roster: mates }, 4_000);
    seedRun(sql, { id: "run_2", action: "roster" });
    const outcome = complete(sql, "acc_a", { runId: "run_2", status: "ok", result: "text" }, 5_000);
    expect(outcome.outcome).toBe("invalid");
    expect(roster(sql, "acc_a")).toHaveLength(2);
  });
});

describe("reading a run", () => {
  test("a pending run past its deadline reads as timed out, and a late report still lands", () => {
    const sql = memorySql();
    seedRun(sql, { id: "run_1", deadlineAt: 2_000 });
    const pending = findRun(sql, "acc_a", "run_1");
    if (!pending) throw new Error("seeded run is missing");
    expect(view(pending, 1_999).status).toBe("pending");
    expect(view(pending, 2_001).status).toBe("timed_out");

    complete(sql, "acc_a", ok("run_1", "late but real"), 9_000);
    const done = findRun(sql, "acc_a", "run_1");
    if (!done) throw new Error("completed run is missing");
    expect(view(done, 9_001)).toMatchObject({
      status: "done",
      result: "late but real",
      completedAt: new Date(9_000).toISOString(),
    });
  });
});
