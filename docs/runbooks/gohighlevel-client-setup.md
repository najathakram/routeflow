# Connecting GoHighLevel to RouteFlow

One page for a client operator to connect their GoHighLevel account so a won lead becomes a
RouteFlow customer automatically. No technical background needed.

> This feature is off by default per tenant (see `apps/api/src/billing/addon-gate-registry.ts`,
> key `crm_gohighlevel`) — ask RouteFlow support to turn it on for your account before starting.

## 1. Get a connection key from GoHighLevel

1. In GoHighLevel, go to **Settings → Private Integrations** (per-location, not per-agency).
2. Click **Create new integration**, give it a name like `RouteFlow`.
3. Grant these scopes: **Contacts** (read + write), **Opportunities** (read; write only if
   "Mark the lead as Won" is used), **Custom fields** (read + write), **Location** (read).
4. Click **Generate**, then copy the token it shows you — GoHighLevel only shows it once.

## 2. Paste it into RouteFlow

1. In RouteFlow, go to **Settings → GoHighLevel**.
2. Paste the token into **Connection key** and your GoHighLevel location into **GoHighLevel
   account ID** (find this under GoHighLevel's **Settings → Business Profile**, "Location ID").
3. Click **Save & test**. You should see a green **Connected** badge and a toast naming your
   GoHighLevel account.
   - If instead you see **RouteFlow lost access to GoHighLevel** or a "rejected this key" error,
     the token was mistyped or its scopes are missing — repeat step 1 with a fresh token.

## 3. Pick when a lead becomes a customer

In the **When does a lead become a customer?** card, choose one:

- **When a lead reaches a stage** (default) — pick the Pipeline and Stage a lead must reach.
- **When a lead is marked Won**.

Only leads that reach that point **after** the "Start from" date are picked up — older leads are
not backfilled automatically (use **Import existing leads** below for those).

## 4. Review before it goes live

**Preview mode** is ON by default: RouteFlow shows you what it _would_ create in the Activity
table below, without creating anything or writing anything back to GoHighLevel. Watch this list
for a few leads and confirm it looks right.

When you're ready, turn **Preview mode** off and turn on **Create customers automatically**.
Automatic checks run every few minutes; the Activity card's "Last checked" time and the
**Check now** button let you see the latest state without waiting.

## 5. What RouteFlow writes back to GoHighLevel (optional)

Under **Options → Write back to GoHighLevel**, you can choose to have RouteFlow:

- add a `routeflow-customer` tag to the linked GoHighLevel contact, and/or
- fill three RouteFlow fields on the contact (customer id, order/invoice link, linked date) and
  leave a note.

RouteFlow never changes a contact's name, email, or phone — GoHighLevel stays the source of
truth for those.

## Import existing leads (one-time)

If you already have leads sitting at your chosen stage from before you connected, use **Import
existing leads → Preview existing leads** to see what would be created, then **Import these** to
bring them in as a one-time batch. This does not repeat automatically.

## Troubleshooting

| You see...                          | It means...                                        | Do this                                                           |
| ----------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| Needs attention badge               | GoHighLevel rejected the connection key            | Create a new key (step 1) and paste it in                         |
| "Automatic checks seem delayed"     | Nothing has checked in over 10 minutes             | Click **Check now**; if it stays stale, contact RouteFlow support |
| A lead is missing from Activity     | It reached the stage before your "Start from" date | Use **Import existing leads**                                     |
| Nothing created after turning it on | Preview mode is still on                           | Turn off Preview mode in **Options**                              |
