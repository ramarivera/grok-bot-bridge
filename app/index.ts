import { defineApp, router, userInterval } from "apps";
import { callback } from "./src/callback.js";
import { requirements } from "./src/provider.js";
import { dispatch, refreshTeammates, report, result, runs, status, teammates } from "./src/runs.js";

export default defineApp(requirements, {
  tools: router(
    { dispatch, result, runs, teammates, refreshTeammates, status, report },
    {
      title: "Grok Bot Bridge",
      description:
        "Send prompts to Grok Bot teammates through one router bot and read their results.",
      instructions: [
        "Grok Bot has no API for messaging a bot. This app starts the router bot's webhook routine, and the router hands the prompt to the teammate you name and reports the answer back.",
        "Every call is asynchronous. `dispatch` returns a runId within a second; the answer takes as long as the teammate needs, often minutes. Read it with `result` and wait between reads; do not dispatch the same prompt again while a run is pending.",
        "Pick the target from `teammates`, which is a cached roster. If it is empty or looks stale, call `refreshTeammates`, wait for that run to be done, then read `teammates` again.",
        "`timed_out` means no report arrived before the deadline, not that the teammate did nothing: an unattended bot can be stopped by an approval nobody answered. The work may still be in the bot's chat.",
        "Grok Bot allows 200 routine runs an hour per routine and 300 across all routines. Every dispatch and every roster refresh is one run.",
        "The prompt is delivered word for word and the teammate cannot ask you follow-up questions, so make it self-contained.",
      ].join("\n\n"),
    },
  ),
  webhooks: { callback },
  schedules: { roster: userInterval({ hours: 24 }, refreshTeammates, {}) },
});
