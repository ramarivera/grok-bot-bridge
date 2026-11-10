import { describe, expect, test } from "bun:test";
import {
  BRIDGE,
  bearer,
  buildPayload,
  CallbackError,
  matchTeammate,
  parseCallback,
  publicStatus,
  randomToken,
  routineUrl,
  sameDigest,
  sha256Hex,
  timeoutMinutes,
} from "../src/protocol.js";

describe("buildPayload", () => {
  const base = { runId: "run_1", callbackUrl: "https://x.test/cb", token: "t" };

  test("a dispatch carries the target and prompt word for word", () => {
    expect(
      buildPayload({ ...base, action: "dispatch", target: "Eggbot", prompt: "do  it\n" }),
    ).toEqual({
      bridge: BRIDGE,
      action: "dispatch",
      run_id: "run_1",
      target: "Eggbot",
      prompt: "do  it\n",
      callback: { url: "https://x.test/cb", token: "t" },
    });
  });

  test("a roster call has no target or prompt keys", () => {
    const payload = buildPayload({ ...base, action: "roster", target: "x", prompt: "y" });
    expect(Object.keys(payload)).toEqual(["bridge", "action", "run_id", "callback"]);
  });
});

describe("parseCallback", () => {
  test("accepts a result", () => {
    expect(parseCallback({ run_id: "run_1", status: "ok", result: "42" })).toEqual({
      runId: "run_1",
      status: "ok",
      result: "42",
      roster: undefined,
      token: undefined,
    });
  });

  test("keeps an empty result, which is a valid answer", () => {
    expect(parseCallback({ run_id: "run_1", status: "ok", result: "" }).result).toBe("");
  });

  test("normalizes a roster and fills missing fields", () => {
    const parsed = parseCallback({
      run_id: "run_1",
      status: "ok",
      roster: [
        { name: " Eggbot ", description: "designer" },
        { name: "Switchbro", handles: "ops" },
      ],
    });
    expect(parsed.roster).toEqual([
      { name: "Eggbot", description: "designer", handles: "" },
      { name: "Switchbro", description: "", handles: "ops" },
    ]);
  });

  test("an error without details still says something", () => {
    expect(parseCallback({ run_id: "run_1", status: "error" }).error).toContain("without details");
  });

  test("reads a token sent in the body", () => {
    expect(parseCallback({ run_id: "run_1", status: "ok", result: "x", token: "abc" }).token).toBe(
      "abc",
    );
  });

  test.each([
    ["an array", []],
    ["a string", "nope"],
    ["a missing run_id", { status: "ok" }],
    ["an unknown status", { run_id: "run_1", status: "done" }],
    ["a non-string result", { run_id: "run_1", status: "ok", result: 5 }],
    ["a roster that is not an array", { run_id: "run_1", status: "ok", roster: "Eggbot" }],
    ["a roster entry without a name", { run_id: "run_1", status: "ok", roster: [{ name: " " }] }],
    [
      "duplicate roster names",
      { run_id: "run_1", status: "ok", roster: [{ name: "Eggbot" }, { name: "eggbot" }] },
    ],
  ])("rejects %s", (_label, input) => {
    expect(() => parseCallback(input)).toThrow(CallbackError);
  });
});

describe("matchTeammate", () => {
  const names = ["Eggbot", "Switchbro"];

  test("matches regardless of case and padding, returning the roster spelling", () => {
    expect(matchTeammate(names, "  eggBOT ")).toBe("Eggbot");
  });

  test("does not match a partial name", () => {
    expect(matchTeammate(names, "Egg")).toBeUndefined();
  });
});

describe("publicStatus", () => {
  test("a pending run past its deadline reads as timed out", () => {
    expect(publicStatus("pending", 1_000, 1_001)).toBe("timed_out");
    expect(publicStatus("sending", 1_000, 1_001)).toBe("timed_out");
  });

  test("a pending run at its deadline is still pending", () => {
    expect(publicStatus("pending", 1_000, 1_000)).toBe("pending");
  });

  test("a finished run keeps its status however late it is read", () => {
    expect(publicStatus("done", 1_000, 9_999)).toBe("done");
    expect(publicStatus("error", 1_000, 9_999)).toBe("error");
    expect(publicStatus("failed", 1_000, 9_999)).toBe("failed");
  });
});

describe("routineUrl", () => {
  test("accepts https on Grok Bot's webhook host and trims", () => {
    expect(routineUrl(" https://api2.cursor.sh/hook/1 ")).toBe("https://api2.cursor.sh/hook/1");
  });

  test("rejects http and garbage", () => {
    expect(() => routineUrl("http://api2.cursor.sh/hook")).toThrow("https");
    expect(() => routineUrl("not a url")).toThrow("valid URL");
  });

  test("rejects any host the key is not pinned to", () => {
    for (const url of [
      "https://example.test/hook",
      "https://cursor.sh/hook",
      "https://a.b.cursor.sh/hook",
      "https://api2.cursor.sh.evil.test/hook",
      "https://evilcursor.sh/hook",
      "https://api2.cursor.sh:8443/hook",
      "https://api2.cursor.sh@evil.test/hook",
    ])
      expect(() => routineUrl(url)).toThrow("*.cursor.sh");
  });
});

describe("timeoutMinutes", () => {
  test("defaults to 30 and floors fractions", () => {
    expect(timeoutMinutes(undefined)).toBe(30);
    expect(timeoutMinutes(12.9)).toBe(12);
  });

  test("rejects values outside 1 to 240", () => {
    for (const value of [0, -5, 241, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => timeoutMinutes(value)).toThrow("between 1 and 240");
  });
});

describe("tokens", () => {
  test("tokens are 64 hex characters and differ", () => {
    const first = randomToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(randomToken()).not.toBe(first);
  });

  test("sha256Hex matches the known digest of abc", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("a token verifies against its own digest only", async () => {
    const token = randomToken();
    const stored = await sha256Hex(token);
    expect(sameDigest(await sha256Hex(token), stored)).toBe(true);
    expect(sameDigest(await sha256Hex(`${token}0`), stored)).toBe(false);
    expect(sameDigest("abc", "abcd")).toBe(false);
  });

  test("bearer reads the header value or nothing", () => {
    expect(bearer("Bearer abc123")).toBe("abc123");
    expect(bearer("bearer   abc123")).toBe("abc123");
    expect(bearer("Basic abc123")).toBeUndefined();
    expect(bearer("Bearer two words")).toBeUndefined();
    expect(bearer(null)).toBeUndefined();
  });
});
