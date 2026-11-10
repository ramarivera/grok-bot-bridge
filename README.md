# Grok Bot Bridge

An Executor app that lets an agent send a prompt to one of your Grok Bot teammates and read the
answer back.

Grok Bot has no API for messaging a bot. The one thing you can call from code is a routine's
webhook, and that call only starts a run: the answer never comes back on the HTTP response. This
app works around both limits with one extra bot.

## How it works

```
agent ── dispatch(target, prompt) ──▶ Executor app ── POST routine webhook ──▶ Bridge bot
                                                                                   │ hands the prompt
                                                                                   ▼ to the target bot
agent ◀── result(runId) ── Executor app ◀── POST callback URL + run token ── Bridge bot
```

1. `dispatch` saves a run, mints a single-use token, and POSTs the Bridge bot's routine webhook
   with the target, the prompt, a callback URL and the token.
2. The Bridge bot's routine hands the prompt to the target teammate and waits for its reply.
3. The routine POSTs the reply to the callback URL. The app checks the token and stores the result.
4. `result` reads the stored run.

The roster works the same way: `refreshTeammates` asks Bridge for the list of your bots, the app
caches it, and `teammates` serves the cache instantly.

## Setup

You need this app in your Executor and one Grok Bot teammate.

1. Deploy this directory to Executor (see Development).
2. Create the Bridge bot from [template/router-bot.md](template/router-bot.md). It is two prompts:
   one for your main bot and one for Bridge itself, with one placeholder to fill in.
3. Connect the app's `router` account with the routine's **POST to** URL and **key**.
4. Run `refreshTeammates` and read the run. `done` proves the loop end to end.

## Tools

| Tool               | What it does                                                                         |
| ------------------ | ------------------------------------------------------------------------------------ |
| `dispatch`         | Send `prompt` to the teammate named `target`. Returns `runId` at once.               |
| `result`           | Read one run by `runId`.                                                             |
| `runs`             | Recent runs, newest first, with results cut to 280 characters.                       |
| `teammates`        | The cached roster: name, description, what each bot handles.                         |
| `refreshTeammates` | Ask Bridge for the current roster. Returns a `runId`.                                |
| `report`           | Record a run's outcome. Only for a Bridge bot that has this app connected as a tool. |

Run statuses:

- `sending`: the webhook call is in flight.
- `pending`: Grok Bot accepted the call and the run started.
- `done`: the teammate's answer is stored.
- `error`: Bridge reported a problem, such as an unknown teammate.
- `failed`: Grok Bot did not start a run. The routine is paused or the key is stale.
- `timed_out`: no report arrived before the deadline, 30 minutes unless you pass `timeoutMinutes`.
  A late report is still recorded.

## What is not proven yet

The design leans on three things Grok Bot's docs don't state. Test them before you rely on this.

- **A non-primary bot delegating.** The docs describe the primary bot coordinating your other
  bots. They don't say a teammate like Bridge can hand work to another teammate, or that it gets
  the reply back. If it can't, put the same routine on your primary bot; the app doesn't care
  which bot hosts it.
- **Delegation inside an unattended routine run.** Not documented either way.
- **An unattended outbound POST.** A routine run that raises an approval card nobody answers has
  it expire after 30 minutes, and the action is not done. If the callback POST needs approval,
  runs end as `timed_out`. Approve it once with "Always allow" during a watched test.

## Limits

- Grok Bot allows 200 runs an hour per routine and 300 across all your routines. Every dispatch
  and roster refresh is one run, and they all share Bridge's one routine.
- A prompt is at most 100,000 characters and a callback body at most 1 MiB.
- The webhook response carries no run id and Grok Bot has no status API, so the app can't tell a
  slow teammate from a run that died. `timed_out` covers both.
- The `roster` schedule refreshes the roster daily. Schedules start paused in Executor.

## Security

- The routine's key lives in Executor's account store. It is sent only to the linked `url`, which
  must be https.
- Each run gets its own random token. The app stores only its SHA-256 digest and accepts one
  report per run, so a leaked token can't rewrite a finished run.
- The Bridge routine posts only to callback URLs under the prefix written into its instruction.
- Whoever can call `dispatch` can make your bots act with whatever access they have. The app runs
  per Executor user, with that user's linked Bridge bot.
- The `routine` provider declares no `hosts` because Grok Bot's webhook host isn't documented.
  Pin it once you know yours; adding hosts means reconnecting the account.

## Development

```sh
npm install --no-package-lock
npm run typecheck
npm run check
npm test
```

Deploy with the Executor CLI:

```sh
executor apps create --name "Grok Bot Bridge" --files .   # first time
executor apps deploy --app <app-id> --files .              # every change
```

`apps` is pinned to the version the host runs; `executor apps framework` prints it. The wire
contract lives in `src/protocol.ts` and, in words, in `template/router-bot.md`. Change them
together.
