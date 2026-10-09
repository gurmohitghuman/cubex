# Enrichments

Enrichments look things up for each row of a sheet: a verified work email, a phone number, a person's title and company, a company's size and industry, or a list such as the people who work at a company. Cubex runs them through [treg.to](https://treg.to), a service that connects to 100+ data providers, using your own treg key. treg bills your treg balance; Cubex itself charges nothing.

You pick a job, match its inputs to your columns, try it on 5 rows, then run the rest. The answers land in new columns, and you can turn on auto-run so new rows fill themselves.

## What enrichments do

Click **Enrichment** in the sheet header (next to **AI Column**). The drawer opens on the popular jobs:

| Job | What it does |
|---|---|
| Verified work email | Finds an email, checks it, and tries other providers until one passes. |
| Find phone number | Finds a phone number from a name and company, or a LinkedIn URL. |
| Verify email | Checks whether a mailbox accepts mail before you send. |
| Person from LinkedIn or email | Fills in name, title and company for a person. |
| Company from domain | Fills in size, industry and location for a company. |
| People at a company | Adds the people it finds as rows in another sheet. |
| Find companies | Adds the companies it finds as rows in another sheet. |
| Google search results | Adds the top Google results for each row's search as rows in another sheet. |

For anything else, type what you want to find in the search box ("work email", "phone", "tech stack") to search treg's catalog. Results come in two groups:

- **Waterfalls** ask several providers in turn, and stop at the first one that finds the answer. You choose which providers take part and in what order.
- **Single providers** ask one provider.

Prices come live from treg and show on every job and provider. Most providers charge only when they find something ("$0.0050 when found"). Some charge for every try, found or not, and the setup says so. In a waterfall you pay for the providers that charged on the way to the answer, so with "when found" providers that's only the one that found it.

## What you need

- **A treg account with money on its balance.** treg is prepaid. Sign up at [treg.to](https://treg.to/app) and top up under [Billing](https://treg.to/app#billing).
- **A treg team API key.** A personal login token (the one `treg login` makes) doesn't work, and Cubex tells you so when you save it.
- **Cubex able to reach treg.to** over the internet.
- **A sheet with the inputs**, for example people's names and their company websites, emails, LinkedIn URLs or company domains.

You can also connect your own keys with data providers at treg. Calls on those keys are billed by the provider directly, not from your treg balance, and Cubex's limits can't cover them.

## Set up your treg key

1. In treg, open your team, then **API keys**, then **Create key**. Copy the key.
2. In Cubex, open **Settings → Enrichment**, paste it into **treg API key**, and click **Save Key**. Cubex tests it right away and shows what treg says.
3. Below the key, check the **Daily limit**: $10 a day by default, for all enrichments together.

The key is stored encrypted and only ever sent to treg. It isn't shown again; to change it, paste a new one, or click **Clear Key**.

## Your first enrichment

Say you have a sheet of leads with **Name** and **Website** columns and you want a work email for each.

1. Open the sheet and click **Enrichment**.
2. Under **Popular**, pick **Verified work email**.
3. **Inputs.** Cubex matches inputs to columns by name. Check that the person's name points at **Name** and the company domain at **Website**. **Clean up to a domain** turns `https://www.acme.com/about` into `acme.com`. Each extra input you map lets more providers try.
4. **Providers.** The waterfall's providers, in the order they're asked. Drag them (or use the arrows) to change the order, and switch off any you don't want. Providers on your own keys and free sources always go first. **Only the first provider that can answer runs** is cheaper but finds less.
5. **Email checks.** Choose which addresses count: **Valid only (safest)**, **Valid or catch-all**, or **Valid, catch-all or risky**. **Try a guess first** checks a common pattern (such as `first.last@domain`) before paying for a find; the guess costs only the check, which is free with some checkers. If a found address doesn't pass, it tries up to 3 finds per row, skipping providers already tried.
6. **Outputs.** The new columns: **Work email**, **Email status** and **Found by** (and **Checked by**, off by default). Rename them if you like.
7. **Rows and limits.** Which rows to run on (all rows, the rows in the current filter, or the rows you selected), **Only run if** conditions, **Max per row**, **Stop the run at**, **Always fetch fresh data** and **Auto-run**. See [Costs and limits](#costs-and-limits) and [Auto-run](#auto-run).
8. Read the gray box: the estimated cost for the rows, your treg balance, and what's left of today's limit. Rows missing an input are skipped and cost nothing.
9. Click **Run on 5 rows**. It runs the first 5 rows that match, and the drawer shows each row's result and what it cost.
10. If the results look right, click **Run on N more rows** and confirm. The confirm repeats the estimate and the limit the run stops at.

The run fills a status column (named after the job) and the output columns. You can close the drawer; the cells keep filling. To come back to the run while it's running or paused, use **View Run** in the status column's menu.

What the status column says:

| Cell | Meaning |
|---|---|
| `✅ Found` | A provider found it. The output columns are filled. |
| `✅ Valid`, `✅ Catch-all`, `✅ Risky` | Verified work email found an address that passed your email checks, and how the checker rated it. |
| `⏭️ Not found` | No provider found anything. |
| `⏭️ Budget ran out` | Max per row stopped the waterfall before a provider found it. |
| `⏭️ No valid email found`, `⏭️ Only a catch-all address (not accepted)` | Verified work email found nothing your email checks accept. Email status (and Checked by, if you added it) is still filled; Work email isn't. |
| `❌ …` | The row failed, with the reason. |
| `⏳ Processing...` | The row is running. |

An empty status cell means the row hasn't run. Click the status column's header for its menu: **Run Rows Not Enriched**, **Retry Failed Rows**, **Run Selected Rows** (when you've selected rows), **Run All Rows Again**, **Edit Enrichment** and the auto-run settings. Each run shows its estimate in a confirm first. Running rows again replaces their results, and they cost again.

## Examples

### Verified emails for a lead list

Follow [Your first enrichment](#your-first-enrichment). Two useful changes:

- If some rows already have an email, add **Only run if**: `Email` **is empty**, so you only pay for the rows that need one.
- If you need more addresses and can live with some bounce risk, set **Email checks** to **Valid or catch-all**. Catch-all domains accept every address, so the checker can't confirm the mailbox.

### Company data from domains

You have a list of companies with a **Domain** column.

1. Click **Enrichment** and pick **Company from domain**.
2. Map the company domain input to **Domain**.
3. Under **Outputs**, pick the fields you want as columns (size, industry, location and whatever else the job returns).
4. **Run on 5 rows**, check the results, then run the rest.

Later, if you want a field you didn't pick, click a cell and use **+ Column** in the answer panel. It fills from the answers you already have, for free. See [The answer panel and adding fields](#the-answer-panel-and-adding-fields).

### People at companies into a new sheet

You have a sheet of target accounts and want the people who work there, one row per person, in a sheet of their own.

1. Click **Enrichment** and pick **People at a company**.
2. Map the inputs (for example the company domain to **Website**).
3. **Put each result in**: **A new sheet**, and name it, for example `People`. It's added as a new tab of this table when the run starts. Or pick **Another sheet** of this table; new rows go after the rows it has.
4. **Provider**: a job that adds rows asks one provider, because each provider returns its own fields. Pick one.
5. **Results per row**: how many people to keep per company (10 by default, up to 100). This is the price dial: a provider that charges per result bills each one.
6. **Also copy from this row**: for example **Company**, so each new row says which account it came from.
7. Click **Run on 5 rows**. When they finish, the drawer shows the fields the results really have. Pick the ones to keep under **Fields to keep**. To avoid duplicates on later runs, turn on **Skip results already added, matched on** and choose a field such as the LinkedIn URL. Click **Add these rows**.
8. Click **Run on N more rows** to do the rest with the same fields.

The status column says what each account added (`✅ 10 rows added`, with `, 2 already there` when duplicates were skipped). If the destination sheet reaches its row limit, the run pauses; make room, then resume.

### From a webhook to Smartlead, hands off

New sign-ups arrive by webhook. You want each one to get a verified work email and, if the email is valid, go straight into a Smartlead campaign. Three columns do it, each filling the next.

1. **The webhook.** Set up a [webhook](webhooks.md) on a sheet, send a test event with a person's name, company and website, and pick those fields as columns (say **Name**, **Company** and **Website**). Then send a second test event, so the sheet has a row with those fields filled. Use your own name and company, so the lead that reaches Smartlead in step 4 is you.
2. **Find the email.** Click **Enrichment**, pick **Verified work email**, map **Name** and **Website**, and set **Email checks** to **Valid only (safest)**. Under **Rows and limits**, check **Auto-run** and set its cap (for example $5 a day). Run it on the test row. Auto-run turns on with that run.
3. **Save your Smartlead key.** In **Settings → Enrichment**, under saved API keys, save your Smartlead API key as `smartlead_key`.
4. **Push to Smartlead.** Click **HTTP API** and set up the request that adds a lead to your campaign:
   - Method `POST`, URL `https://server.smartlead.ai/api/v1/campaigns/<campaign id>/leads?api_key={{smartlead_key}}`
   - Body:

     ```json
     {"lead_list": [{"email": "{{Work email}}", "company_name": "{{Company}}", "website": "{{Website}}"}]}
     ```

   Add other fields (first name, custom fields) the same way; Smartlead's API documentation lists them. Name the column `Add to Smartlead`, try it, and run it while the test row is the only row with an email. Both send a real request, so use a test campaign.
5. **Turn on its auto-run.** Open the **Add to Smartlead** column's menu and click **Turn On Auto-run**. Add **Only run if**: `Email status` **is** `valid`, and set **At most** to the leads you want a day (500 by default). Click **Turn on**.

From now on, each event adds a row, Verified work email fills it within its daily cap, and Add to Smartlead sends the lead. An HTTP API auto-run waits until every column its request uses is filled, and with **Valid only** the Work email column is only filled for addresses that passed, so rows without a valid email never go out.

Email status is always one of `valid`, `catch-all`, `risky`, `invalid` or `not checked`, so this condition is safe to rely on. The checker's own word (for example "deliverable") shows in the answer panel.

When you run a column that other auto-runs read, the run's confirm lists them before you start, for example "Also runs: Add to Smartlead (sends up to 1,204 requests)." An enrichment in that list shows its estimated cost.

Anyone who has this sheet's webhook URL can now add rows that spend your treg balance and send leads to Smartlead, up to the caps you set. Treat the URL like a password.

## Costs and limits

Every call is priced by treg and paid from your treg balance. Cubex shows the estimate before each run and gives you three limits.

- **Max per row.** The most one row may cost. Cubex sends it to treg with each call, and a waterfall skips any provider that would take the row past it (the row then says `⏭️ Budget ran out`). Leave it empty to use the default, which lets every provider you kept answer.
- **Stop the run at.** The most the whole run may spend. The run pauses when it gets there; you can raise it and resume. Empty uses the high end of the estimate.
- **Daily limit.** The most all enrichments may spend in a day, counting runs you start, auto-runs and agents together. It's $10 by default and resets at midnight UTC. Change it (or turn it off) in **Settings → Enrichment**. Only you can change it, in the app; an agent's access token can't.

The estimate is a range. The low end is every row found by the cheapest provider; the high end is every row spending its whole Max per row. Most rows cost less than the high end.

Other things that affect cost:

- Rows missing an input are skipped and cost nothing.
- Rows in the same run with the same lookup reuse one answer: the others make no call and cost nothing.
- **Always fetch fresh data** asks treg not to answer from its store of earlier lookups. Without it, treg can answer a repeat lookup from that store, which can be cheaper.
- Providers on your team's own keys at treg bill your team directly. Cubex can't estimate those calls, and no Cubex limit covers them.

To see what you spent: the run screen shows each row's cost, the status column's header shows what the column spent when you hover it, and **Settings → Enrichment → Spending on enrichments** shows the last 7, 30 or 90 days by column.

## Auto-run

Auto-run keeps an enrichment (or an HTTP API column) filling rows by itself. It runs on new rows, and on rows whose inputs get filled, at most once a row. It repeats the column's newest run, with the same setup.

- Rows already in the sheet when you turn it on are left alone. Use the column menu's run actions for those.
- A row it already ran isn't run again when you edit it. A row that failed gets another try when one of its inputs is written.
- **Only run if** conditions apply to auto-run too.

Turn it on with the **Auto-run** checkbox in the drawer (it turns on with the full run, not the 5-row test), or from the column menu with **Turn On Auto-run**. The column has to have run once first.

Each auto-run has a daily cap:

- **An enrichment:** a dollar cap per column, $5 a day by default and never above your daily limit. The daily limit for all enrichments still applies. A job billed on your own provider key at treg has no cap here, since your provider bills it.
- **An HTTP API column:** a number of rows a day, 500 by default. Each row sends a real request (for example, adding a lead to a sequencer), and only when every column the request uses is filled.

Both reset at midnight UTC.

Auto-runs can chain: an HTTP API column can read what an enrichment fills, and so on. When a run will set off other auto-runs, its confirm says so before you start it. When you import a CSV into a sheet with auto-run on, the import shows what auto-run will do with the new rows and lets you pause auto-run for that import.

While auto-run is on, the sheet header shows **Auto-run on**. Click it to see each auto-run and to pause or resume them all. In the column's auto-run settings, **Pause** keeps the rows added meanwhile and runs them when you resume; **Turn off** skips them, and turned on again it starts from the rows there then.

Auto-run can also pause by itself, and says why on the column header: its cap or the daily limit (it goes on after midnight UTC, or raise the cap), no treg key (it goes on once you add one), treg unreachable or your balance empty (it tries again a few minutes later), or a column it reads was deleted (it waits until a column by that name is back).

## The answer panel and adding fields

Click a filled cell of an enrichment column (its status column or an output) to open the answer panel. It shows:

- What the row's status says, and what the row cost from your treg balance.
- **Found by**: the provider that found it, and whether it ran on treg's key, your own key or a free route.
- Each step Cubex took (for Verified work email: the guess, each find and each check) and the providers treg tried, with what each one said and cost.
- **Result**: the row's cells.
- **Full answer**: everything treg returned that Cubex kept.

Next to any value in the full answer, **+ Column** adds a new column filled from the answers you already have, for every row. It's free: no new calls to treg. Its cells show ⏳ until every row is filled, rows whose answer lacks that value stay empty, and later runs of the column fill it too.

**Rerun this row** calls treg again for that row, and it costs again. **Copy diagnostics** copies the run, the row and each treg call id with its status and cost. treg's call ids are what treg's Activity page and treg's support use to look a call up.

HTTP API columns have the same panel (minus cost and providers), and **+ Column** works there too.

## Stored answers and disk space

To make the answer panel and **+ Column** work, Cubex keeps each row's answer in its database:

- treg's result fields and its notes about the call, whole.
- The provider's own raw data, trimmed to 16 KB per answer (the largest parts go first; the panel says what was left out). Operators can change the size with `ENRICH_STORED_RAW_MAX_BYTES`.

That adds up on big sheets, so Cubex trims it in two ways:

- **When a row is enriched again**, Cubex removes the raw data from that row's older answers in the background. The newest answer keeps it. Result fields always stay.
- **By hand**: **Settings → Enrichment** shows "Stored answers: 1.2 GB in 12,345 answers, counted 5 minutes ago". It's counted in the background: again when you open Settings and the last count is over an hour old, and after each prune. **Prune details older than 90 days** removes the raw data from answers of enrichment runs that ended over 90 days ago. It asks you first, and it can't be undone: values that were only in the raw data can't become columns afterwards. Cells, result fields and the answer panel keep working, and the panel says when an answer's raw data was removed.

The answer of a single provider (not a waterfall) is all raw data, so neither kind of pruning touches it; it's only trimmed to 16 KB when stored.

Deleting a row deletes its stored answers. Cubex keeps its record of what each call cost (about 100 bytes a call) so your spending history stays right.

**Making the database file smaller.** Pruned space is reused for new data, but the database file doesn't shrink on its own. To shrink it, compact it while Cubex is stopped. You need free disk space about the size of the database. With the one-line installer:

```bash
cubex stop
~/.cubex/app/scripts/backup-cubex-db.sh ~/.cubex/data/cubex.db ~/cubex-before-compact.db
sqlite3 ~/.cubex/data/cubex.db 'VACUUM;'
cubex start
```

The second line takes a backup first ([Your data and backups](../README.md#your-data-and-backups) has more), and the third compacts the file. It can take a few minutes on a big database. `sqlite3` comes with macOS; on Ubuntu or Debian, install it with `sudo apt install -y sqlite3`. When Cubex is running again and your sheets look right, delete the backup copy if you need the space.

## Using enrichments from an agent

Connected agents can do all of this over MCP or the REST API: search for a job, estimate it, run it on 5 rows, add list results as rows, add columns from stored answers, and turn auto-run on or off. The access token needs the `run` scope to start runs. The tools and their answers are in [docs/mcp.md](mcp.md#enrichments).

Try asking:

- "Find a verified work email for everyone in Leads, using Name and Website. Show me the estimate first, then run 5 rows and show me what came back."
- "Add the people at each company in Accounts to a new sheet called People, 10 per company. Try 5 companies first and show me which fields come back."
- "Keep finding work emails for new rows in Leads automatically, up to $5 a day."

## Privacy and your data

- **What goes where.** Enrichment calls go only to treg.to, and only once you've saved a treg key. Each call sends the values of the columns you mapped as inputs for that row, nothing else from the sheet. treg and the providers it routes to process those values. Opening **Enrichment** also reads treg's catalog, including what you type in its search box, with no row data.
- **What treg keeps.** treg can keep requests and answers to serve repeat lookups. Cubex has no setting that stops it. Read treg's [privacy policy](https://treg.to/privacy) and [terms](https://treg.to/terms) before you send personal data.
- **Attribution.** Every call says it comes from Cubex (an `X-Treg-Client: cubex` header), so treg can see the traffic is from Cubex.
- **Your key.** The treg key is stored encrypted with the `.encryption-key` file in Cubex's data directory and is never shown again. If that file is lost, you enter the key again.
- **Your responsibility.** Enrichments often handle personal data, such as names, emails and phone numbers. You're responsible for having a lawful reason to process it and for how you use the results.
- **Proxies.** Cubex can't send these calls through an HTTP proxy. The server needs direct outbound internet access to treg.to.

## Known limits

- **Cancelling** throws away answers still in flight (up to one batch of rows), and their cost still counts. A later rerun of those rows gets them back for free when treg kept them; treg keeps single-provider answers, not waterfall ones.
- **Pausing and resuming** replays answers treg already charged for, for free. The exception is calls on your own provider key at treg to a single provider, which can be sent to your provider again.
- **Replays last 24 hours and belong to one treg key.** A pause longer than that, or switching to another treg key, can mean paying again for rows that were in flight.
- **No cost shown for some calls.** Calls on your own provider key and free routes carry no cost from treg, so the drawer shows no cost for them and the answer panel says none was reported.
- **The daily limit can be passed a little.** Each enrichment running at the same moment can go over by about one batch of rows.
- **Your treg balance** as Cubex shows it includes amounts on hold for calls in flight, and can lag behind treg.
- **Unconfirmed calls.** If treg doesn't confirm a call (it keeps saying the first call with that key is still running), the run waits up to 15 minutes, then pauses: "treg hasn't confirmed a call for 15 minutes. Resume later to ask again; a call it finished is never charged twice." An auto-run asks again about every 20 minutes. Meanwhile the column counts as busy: renaming or deleting it, sorting the sheet, or another run on it waits.
- **Internet access.** Enrichments need outbound access to treg.to.

## Troubleshooting

A run that pauses by itself says why in the drawer, with the fix next to it. The usual reasons:

| What it says | What to do |
|---|---|
| The run reached its spend limit | That's **Stop the run at**. Raise it in the drawer and resume. |
| Today's enrichment limit is reached | The daily limit for all enrichments. Raise it in the drawer or in **Settings → Enrichment**, or resume after midnight UTC. |
| Your treg balance ran out | [Top up at treg](https://treg.to/app#billing), then **Resume**. If auto top-up is on at treg, its cooldown or monthly cap may be holding it. |
| No treg key | Add one in **Settings → Enrichment**, then **Resume**. |
| treg rejected the key, or treg needs a team API key | Create a team API key in treg (your team, then API keys) and save it in Settings. A personal login token doesn't work. |
| Can't reach treg | Check the server's internet connection, then **Resume**. On a server, check that outbound HTTPS to treg.to is allowed. |
| treg is too busy right now | Resume in a few minutes. |
| Your treg team's daily cap is reached | That cap is set at treg (Team settings), not in Cubex. Change it there or wait for it to reset. |
| Your treg team only allows one provider, or the tool needs your own key or a connected account at treg | A rule of your treg team. Change it at treg, or pick another provider or job. |
| treg hasn't confirmed a call for 15 minutes | Resume later. A call treg finished is never charged twice. |
| The sheet it adds to is full | A list job's destination sheet hit its row limit. Make room there, then **Resume**. |

If a row's result looks wrong, open its answer panel to see which providers were tried and what each said. To ask treg about a call, click **Copy diagnostics** and send the call ids to treg, or look them up on treg's Activity page.
