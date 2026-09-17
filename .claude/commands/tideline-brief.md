Send the daily Tideline brief and move alerts. This is the DELIVERY step.
Run `/tideline` first — it produces the data this reads.

## Schedule

Intended for **17:00 Australian eastern time**, covering the most recently
completed US session. Sydney at 17:00 is 07:00 UTC on AEST and 06:00 UTC on
AEDT, so a fixed UTC cron drifts by an hour across the DST boundary in early
October and early April. Either accept the drift or carry two cron entries.

The US close lands 11 hours before, so the session is fully settled. Note the
consequence: **Friday's US session is briefed on Saturday afternoon Sydney
time.** That is correct by construction, not a bug.

## Do not send on a day with no new session

The briefing must reflect a *new* US trading day. Before sending, check:

1. `date` in `pipeline/data/briefing-latest.json` is a session we have not
   already sent — compare against `pipeline/data/last-brief-sent.json`.
2. That date is within the last 4 days. Older means the price feed is stale and
   the brief is repeating itself.

If either fails, **do not send**. Say so and stop. A briefing that arrives on a
US public holiday restating Friday's numbers trains the reader to ignore it,
which is worse than silence.

After a successful send, write `{ "date": "<session>", "sentAt": "<iso>" }` to
`pipeline/data/last-brief-sent.json` and commit it, so a re-run is idempotent.

## What goes in it

Read `pipeline/data/briefing-latest.json`. Lead with whichever section is
non-empty; drop empty sections rather than printing "none".

1. **Became more attractive** — crossed toward the low end of its corridor.
   Give the zone transition, the price move, corridor position, and the cause.
2. **Became less attractive** — crossed toward the stretched end.
3. **Drifting cheaper (20 sessions)** — earnings accruing under a quiet price.
   This is the section a daily flag alone would miss, and often the most useful
   thing in the brief.
4. **Movers** — >2% for the ten mega caps, >4% for the rest. Absolute
   thresholds; this is a deliberate user decision, do not volatility-normalise.
5. **Reports within 14 days** — where the corridor is least reliable and the
   estimate cutover risk sits.
6. **Estimate cutovers.** Switches that passed both gates are applied
   automatically and must be reported in plain words, since an automated change
   nobody sees silently redraws every band for that name. Held ones need a
   human decision and should be called out as such.

The brief is capped at **15 changes**, walked in market-cap order, so the
largest positions can never be crowded out. If names were suppressed, say how
many and name them in one line.

## Language

These are mechanical corridor readings, not recommendations. Write "crossed into
the attractive end of its corridor", not "buy". The model knows where price sits
against an observable multiple range and nothing else — no view on the business,
the news, or whether the multiple deserves to hold. Keep the standing
"not investment advice" line.

Give numbers, not adjectives. "GOOGL at 12% of corridor, price −1.6% over 20
sessions, roughly half from earnings accrual" beats "GOOGL looking attractive".

## Sending

**Recipient: the address in the `BRIEF_TO` repo secret** (in a local run, the one
confirmed in the scheduled task). Never write it into this repo — it is public. The user
gave explicit standing authorisation on 2026-09-09 for this recurring brief to
that address.

That authorisation covers this daily brief and nothing else. Any other send —
a different recipient, a one-off, anything with an attachment — needs asking
again. Never send to an address inferred from git config or a commit trail.

WhatsApp is not wired up: there is no connector for it in this environment, and
it would need a Twilio WhatsApp Business account with an approved sender. Do not
claim a WhatsApp send happened.

## Related

- `/tideline` — capture and recompute (run first)
- Dashboard: https://sachin-imt.github.io/tradingview-mcp-sachin/

- Runs: https://github.com/sachin-imt/tradingview-mcp-sachin/actions
