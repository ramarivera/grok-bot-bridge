import type { MutationContext, QueryContext, WebhookContext } from "apps";
import { defineProvider, object, plain, secrets, string } from "apps";
import { WEBHOOK_HOST } from "./protocol.js";

// The router bot's routine webhook: the "POST to" URL and the key shown on the routine's page.
// `hosts` pins the key: app code holds only a handle, and Executor's outbound network swaps in the
// real key on requests to that host and nowhere else. routineUrl() refuses any other URL up front.
export const routine = defineProvider({
  name: "Grok Bot routine webhook",
  hosts: [WEBHOOK_HOST],
  auth: {
    webhook: secrets({
      label: "Routine webhook",
      fields: object({
        url: plain(string({ minLength: 1 })),
        key: string({ minLength: 1 }),
      }),
    }),
  },
});

// User scope: Grok Bots are personal, so each member links their own router bot.
export const requirements = { user: { accounts: { router: routine } } };
export type Mut = MutationContext<typeof requirements>;
export type Qry = QueryContext<typeof requirements>;
export type Hook = WebhookContext<typeof requirements>;
export type Sql = Mut["sql"];
/** Queries get read-only SQL, without `transaction`. */
export type Reader = Qry["sql"];
