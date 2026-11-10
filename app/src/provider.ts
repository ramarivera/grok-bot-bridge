import type { MutationContext, QueryContext, WebhookContext } from "apps";
import { defineProvider, object, plain, secrets, string } from "apps";

// The router bot's routine webhook: the "POST to" URL and the key shown on the routine's page.
// No `hosts` yet: the webhook host is whatever Grok Bot shows, and it isn't documented. The app
// sends the key only to the linked URL, which routineUrl() requires to be https.
export const routine = defineProvider({
  name: "Grok Bot routine webhook",
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
