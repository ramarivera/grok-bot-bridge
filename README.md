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
2. The Bridge bot's routine saves the callback details to a file, hands the prompt to the target
   teammate, and stops. A routine run ends when the bot messages another bot, so it can't wait.
3. The target's reply wakes Bridge. Bridge reads the saved file and POSTs the reply to the
   callback URL. The app checks the token and stores the result.
4. `result` reads the stored run.

The roster is simpler: `refreshTeammates` asks Bridge for the list of your bots, Bridge reports
it from inside the webhook run, the app caches it, and `teammates` serves the cache instantly.

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

## What a live test showed

Tested on 2026-11-10 against a self-hosted Executor behind Cloudflare, with a Bridge bot that is
not the primary bot. Grok Bot's docs promise none of this, so treat it as observed, not guaranteed.

- **A webhook run works unattended.** A roster run reported back in 1 minute 39 seconds with no
  one watching and no approval card.
- **A non-primary bot can delegate.** Bridge messaged the target bot directly from inside the
  webhook run, and the target replied in that thread.
- **A routine run ends when the bot messages another bot.** The reply arrives in a later turn that
  no longer has the webhook body. That is why Bridge saves each run to a file before handing over.
- **The webhook answer carries a run id.** Grok Bot answers `{"success":true,"runUuid":"..."}`.
  The app keeps it in `webhookReply`; there is still no API to look that run up.
- **Cloudflare refuses Python's urllib.** A callback sent with the default `Python-urllib`
  user agent gets HTTP 403 `error code: 1010` from Cloudflare and never reaches the app. curl and
  other common clients pass. The routine tells the bot to use curl or set its own user agent.

## Limits

- Grok Bot allows 200 runs an hour per routine and 300 across all your routines. Every dispatch
  and roster refresh is one run, and they all share Bridge's one routine.
- A prompt is at most 100,000 characters and a callback body at most 1 MiB.
- The webhook response carries no run id and Grok Bot has no status API, so the app can't tell a
  slow teammate from a run that died. `timed_out` covers both.
- The `roster` schedule refreshes the roster daily. Schedules start paused in Executor.
- Deploying a new version gives the app a new callback URL and stops the old one. A run that is
  still pending at that moment can no longer report and ends as `timed_out`. Deploy when nothing
  is in flight.

## Security

- The routine's key lives in Executor's account store. It is sent only to the linked `url`, which
  must be https.
- Each run gets its own random token. The app stores only its SHA-256 digest and accepts one
  report per run, so a leaked token can't rewrite a finished run.
- The Bridge routine posts only to callback URLs under the prefix written into its instruction.
- Between hand-over and reply, a run's token sits in a file under `/workspace/bridge-runs/` on the
  bots' shared computer, where your other bots can read it. It completes that one run and nothing
  else, and Bridge deletes the file once the report is accepted.
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
