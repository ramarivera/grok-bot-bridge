// Wire contract between the Executor app and the router bot's routine.
// template/router-bot.md at the repo root describes the same contract to the bot; change both.

export const BRIDGE = "grok-bot-bridge/v1";
export const MAX_BODY_BYTES = 1_048_576;
export const MAX_PROMPT_CHARS = 100_000;
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const MAX_TIMEOUT_MINUTES = 240;
const MAX_ROSTER = 200;

export type Action = "dispatch" | "roster";
export type Teammate = { name: string; description: string; handles: string };
export type Callback = {
  runId: string;
  status: "ok" | "error";
  result?: string;
  roster?: Teammate[];
  error?: string;
  token?: string;
};
export type StoredStatus = "sending" | "pending" | "done" | "error" | "failed";
export type PublicStatus = StoredStatus | "timed_out";

export class CallbackError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function field(source: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new CallbackError(`${key} must be a string.`);
  if (value.length > max) throw new CallbackError(`${key} is longer than ${max} characters.`);
  return value;
}

function teammate(value: unknown, index: number): Teammate {
  if (!isRecord(value)) throw new CallbackError(`roster[${index}] must be an object.`);
  const name = field(value, "name", 200)?.trim();
  if (!name) throw new CallbackError(`roster[${index}].name is required.`);
  return {
    name,
    description: field(value, "description", 2_000)?.trim() ?? "",
    handles: field(value, "handles", 4_000)?.trim() ?? "",
  };
}

/** Validate what the router bot reported. Throws CallbackError with a message safe to return. */
export function parseCallback(input: unknown): Callback {
  if (!isRecord(input)) throw new CallbackError("Body must be a JSON object.");
  const runId = field(input, "run_id", 100);
  if (!runId) throw new CallbackError("run_id is required.");
  const status = input.status;
  if (status !== "ok" && status !== "error")
    throw new CallbackError('status must be "ok" or "error".');
  const token = field(input, "token", 200);
  if (status === "error") {
    const error = field(input, "error", 20_000)?.trim();
    return {
      runId,
      status,
      error: error || "The router reported an error without details.",
      token,
    };
  }
  const result = field(input, "result", MAX_BODY_BYTES);
  let roster: Teammate[] | undefined;
  if (input.roster !== undefined && input.roster !== null) {
    if (!Array.isArray(input.roster)) throw new CallbackError("roster must be an array.");
    if (input.roster.length > MAX_ROSTER)
      throw new CallbackError(`roster has more than ${MAX_ROSTER} entries.`);
    roster = input.roster.map(teammate);
    const names = new Set(roster.map((mate) => mate.name.toLowerCase()));
    if (names.size !== roster.length) throw new CallbackError("roster has duplicate names.");
  }
  return { runId, status, result, roster, token };
}

export function buildPayload(run: {
  action: Action;
  runId: string;
  target?: string;
  prompt?: string;
  callbackUrl: string;
  token: string;
}) {
  return {
    bridge: BRIDGE,
    action: run.action,
    run_id: run.runId,
    ...(run.action === "dispatch" ? { target: run.target, prompt: run.prompt } : {}),
    callback: { url: run.callbackUrl, token: run.token },
  };
}

/** Routine webhooks are HTTPS only; anything else is a setup mistake. */
/**
 * The only host the routine key may be sent to. Grok Bot showed routine webhooks on
 * api2.cursor.sh on 2026-11-10; its docs name no host, so widen this if that changes.
 */
export const WEBHOOK_HOST = "*.cursor.sh";

export function routineUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("The linked routine webhook URL is not a valid URL. Reconnect the account.");
  }
  if (url.protocol !== "https:")
    throw new Error("The linked routine webhook URL must use https. Reconnect the account.");
  if (!isWebhookHost(url.host))
    throw new Error(
      `The linked routine webhook URL must be on ${WEBHOOK_HOST}, where Grok Bot serves routine webhooks. Reconnect the account with the routine's "POST to" address.`,
    );
  return url.href;
}

/** True for one subdomain level under the pinned domain on the default port, as the host matches it. */
export function isWebhookHost(host: string): boolean {
  const suffix = WEBHOOK_HOST.slice(1);
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, -suffix.length);
  return label.length > 0 && !label.includes(".") && !label.includes(":");
}

/** Case-insensitive exact match against the cached roster; returns the roster's spelling. */
export function matchTeammate(names: readonly string[], target: string): string | undefined {
  const wanted = target.trim().toLowerCase();
  return names.find((name) => name.trim().toLowerCase() === wanted);
}

/** A run with no report past its deadline reads as timed out. A late report is still recorded. */
export function publicStatus(status: StoredStatus, deadlineAt: number, now: number): PublicStatus {
  return (status === "pending" || status === "sending") && now > deadlineAt ? "timed_out" : status;
}

export function timeoutMinutes(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_TIMEOUT_MINUTES;
  if (!Number.isFinite(requested) || requested < 1 || requested > MAX_TIMEOUT_MINUTES)
    throw new Error(`timeoutMinutes must be between 1 and ${MAX_TIMEOUT_MINUTES}.`);
  return Math.floor(requested);
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

/** Length-independent comparison is not needed: both sides are fixed-length hex digests. */
export function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

export function bearer(header: string | null): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
}
