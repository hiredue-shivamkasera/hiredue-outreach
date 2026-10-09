# HireDue Outreach

Full documentation, for people using the app and for developers extending it, is in [docs/](docs/README.md).

A desktop app for building LinkedIn outreach as a graph of steps, n8n style, and running it on your own logged-in LinkedIn accounts. A workflow is a set of steps joined by arrows. A run passes a list of posts or people down the arrows, and each step works on that list and hands its result on.

Four workflows are created on first launch:

- **Hiring post commenters.** Search posts for "hiring", collect people who commented "interested", read their profiles, have the AI qualify them, write a note, send an invite.
- **B2B call qualifiers.** People search for "founder B2B SaaS", read profiles, qualify who takes vendor calls, write a note, send an invite.
- **Daily post engagement.** On a weekday schedule, search the last day's "B2B sales" posts, have the AI pick the substantive ones, react Insightful, and leave an AI-written comment. It is created switched off.
- **AI fit check.** People search for "head of sales SaaS", read profiles, have an AI prompt score fit and say whether they make the buying decision, and send an invite only to people with a score of at least 70 who do.

## Running it

```bash
npm install           # also downloads Electron
npm run rebuild       # builds better-sqlite3 for Electron's Node
npm run dev           # Vite + Electron with hot reload
npm test              # the rules and steps, no browser needed
```

The browser is Camoufox, the same pinned build `hiredue-desktop-application` uses (152.0.4-beta.30), installed once in `~/Library/Caches/camoufox`. **This app never installs Camoufox**, because camoufox-js deletes that whole directory whenever it fetches, which would break the desktop app. If a run says Camoufox is missing, run `npm run camoufox:fetch` in `hiredue-desktop-application`.

If Electron starts as plain Node (`app` is undefined), your shell has `ELECTRON_RUN_AS_NODE=1` set. VS Code's extension host sets it. Run `unset ELECTRON_RUN_AS_NODE` first.

First use:

1. **AI and browser.** Paste a LiteLLM key. The endpoint defaults to `https://ai.hiredue.com/v1` and the model to `deepseek-v4-flash`; any OpenAI-compatible endpoint works. The key is encrypted with the macOS keychain before it is stored.
2. **LinkedIn accounts.** Add an account and press Log in. A browser window opens. Sign in yourself, two-factor included, and the window closes once the feed loads. The session lives in that account's browser profile.
3. Open a workflow, choose the account, press Run. Click any step during or after a run to see what it produced.

## Steps

The palette groups steps in this order: Triggers, Search, Feed, Posts, Profile, Messaging, CRM, AI, Logic.

| Group | Step | Takes | Gives | What it does |
|---|---|---|---|---|
| Triggers | Start | nothing | trigger | fires when you press Run |
| Triggers | Schedule | nothing | trigger | fires every N minutes inside set hours and days, with a random shift |
| Triggers | Poll API | nothing | people, pages or posts | checks a JSON API on a timer; each record not seen before becomes an item |
| Search | Search posts | trigger | posts | LinkedIn content search with date and sort filters |
| Search | Search people | trigger | people | LinkedIn people search, filtered by connection degree |
| Search | LinkedIn URLs | trigger | people, pages or posts | a list of links you paste in |
| Feed | Feed posts | trigger | posts | scrolls the account's home feed and collects its posts, skipping ads |
| Posts | Post commenters | posts | people | opens each post, loads comments, keeps people whose comment contains your words |
| Posts | Like post | posts | posts reacted to | Like, Celebrate, Support, Love, Insightful or Funny |
| Posts | Comment on post | posts | posts commented on | posts a comment, usually `{{draft}}` |
| Posts | Repost | posts | posts reposted | plain repost, or with your own words on top |
| Profile | Visit profile | people | people | reads headline, location, degree, About, Experience |
| Profile | Follow | pages, people or posts | same | follows a company or school page, a person, or a post's author |
| Profile | Send connection request | people | people invited | invite with an optional note |
| Messaging | Send message | people | people messaged | messages 1st-degree connections |
| Messaging | Follow-up sequence | people | people enrolled | books follow-up messages for people this account already messaged; sends nothing itself |
| Messaging | Check replies | people | replied / no reply | reads each conversation and splits by whether they wrote back after your last message |
| CRM | From CRM | trigger | people | people already in the CRM for this account, filtered by stage and tag |
| CRM | Update CRM | people | same | sets a stage, adds tags or writes a note on each person's record |
| AI | AI prompt | anything | same | asks the model your question and stores its answer in fields you define, under `{{ai.<field>}}` |
| AI | AI qualify | anything | pass / fail | the model scores each item against your criteria |
| AI | AI write message | people or posts | same | the model writes a note or a comment, available to later steps as `{{draft}}` |
| Logic | Condition | anything | true / false | splits items by rules on their fields, such as `ai.fit_score` at least 70, no AI |
| Logic | Keyword filter | anything | pass / fail | splits by whether a field contains a word, no AI |

## AI prompt and conditions

**AI prompt** sends the model your prompt, the item's details, and a list of the answer fields you want back. Each field has a name, a type and a description:

- `number`: a number. A quoted number such as `"82"` is read as 82.
- `boolean`: `true` or `false`. Strings like `"yes"` or `"true"` are rejected.
- `choice`: one of the choices you list, such as `junior, senior, founder`. Matching ignores case, and the answer is stored with your spelling.
- `text`: any non-empty text.

The answer is stored on the item under the name in "Store the answer as" (`ai` by default), so later templates can use `{{ai.reason}}`. If the answer is missing a field or has the wrong type, that item fails with the field named in the run log. No default is filled in, because a blank score would look like a low score. If the first three items all fail, the step stops, as other AI steps do.

**Condition** sends each item out of its True or False output. It has one or more rules, each a field, a test and a value, and you pick whether all of them or any of them must hold. The field is a dotted path such as `ai.fit_score`, `headline` or `evaluation.score`. The tests are equals, not equals, contains, does not contain, greater than, less than, at least, at most, is true, is false, is empty and is not empty. Numbers compare as numbers, so `"100"` is above `"70"`. Text compares without regard to case. A rule on a field the item does not have is false, except "is empty", so a person the model never scored goes out False. Broken rules, such as an unknown test or "at least" with no number, show as problems in the editor before you can run.

The **AI fit check** starter workflow uses both: search people, read profiles, have the AI prompt return `fit_score`, `is_decision_maker` and `reason`, keep people with a score of at least 70 who make the decision, and send them an invite.

## CRM and follow-ups

**CRM.** When a run ends, every person and post it handed between steps is filed in the CRM, one record per account and profile link (or post). A newer run updates the record: a field the new run left blank keeps the old value, so last week's AI score stays when today's run only re-searched. Each person has a stage, tags, notes and a timeline of runs, LinkedIn actions, follow-ups, stage changes and notes.

Stages run New, Invited, Connected, Messaged, Replied, Qualified, Meeting, Won, Lost. The first five move on their own from the action ledger: an invite sent or pending makes someone Invited, a 1st-degree badge makes them Connected, a message or follow-up sent makes them Messaged, and a reply seen by a follow-up or Check replies makes them Replied. The automatic move only goes forward and never touches Qualified, Meeting, Won or Lost, which are yours to set. A stage you set by hand can go anywhere and is written on the timeline.

**Follow-ups.** Put Follow-up sequence after Send message. Each message in the sequence goes out its number of days after the message before it, the first one counted from the original message. Only people this account already messaged can be enrolled, and a person has at most one active sequence per account. Enrolling sends nothing.

While the app is open, the scheduler checks for due follow-ups every 30 seconds, whether or not the workflow is Active. For each account with something due, it starts a run (shown in Run history as fired by followUp) that opens each conversation and then:

- if they wrote after your last message, stops the sequence and marks them Replied (unless "Stop when they reply" is off)
- otherwise sends the next message into the same conversation, counted only once LinkedIn clears the message box, and books the one after
- if the conversation cannot be read, sends nothing and tries again in 6 hours; after 3 tries the row is marked failed. An unreadable conversation never counts as "no reply".

Follow-ups go through the action ledger as `followup`, capped at 20 a day by default. A send that comes back `unverified` marks the row failed instead of retrying, because a second try could send the message twice. The Follow-ups page can cancel a sequence or send everything due now for an account. Only one run uses an account's browser at a time, so a busy account's follow-ups wait 5 minutes and try again.

**Renaming an account** changes only its label. The browser profile folder is named after the account's id, so the LinkedIn login survives a rename.

## Run history

**Run history** in the sidebar lists every run of every workflow, newest first, filterable by workflow and status. The editor's History button opens the same list filtered to that workflow. Each row shows what started the run, how long it took, how many items each step handed on, and what it did on LinkedIn.

Opening a run shows:

- the workflow as it was when the run started, so later edits do not rewrite history
- every step's result, input and output counts, errors and time taken; click one for the settings it used, its log, and every item it produced
- everything the run did on LinkedIn, one row per invite, message, follow, reaction, comment or repost, with the result and a link
- the full log, with an errors-only filter

Deleting a run's record removes it from this page only. What it did on LinkedIn stays in the account history and still counts toward the caps.

## Triggers that fire on their own

Start fires only when you press Run. Schedule and Poll API also fire by themselves, but only while the workflow's **Active** switch is on and the app is open. With an Active workflow, closing the window hides it instead of quitting, and the app holds off macOS App Nap. Cmd+Q stops everything. On Windows and Linux, closing the window still quits.

- **Schedule** waits for its first slot after you switch it on; it never fires the moment you activate it. Intervals under 15 minutes are raised to 15.
- **Poll API** checks as soon as it is switched on, then every N minutes (5 at least). Point it at any JSON endpoint, say where the list is (`data.leads`), which field holds the LinkedIn link, and which field identifies a record. Only new records start a run, so an API with nothing new never opens the browser. Records are marked as used only once their run has started; if the account is busy, they wait for the next check. The other fields in each record come along, so a note template can use `{{note}}` or any field the API sends. Headers, API keys included, are stored in the workflow in plain text in the local database.
- When a trigger fires, only that trigger's branch runs. Pressing Run fires every trigger in the workflow, which polls the API once.
- If the account is busy with another run, a due trigger tries again 5 minutes later. Errors (an API returning 401, a workflow that no longer validates) show on the trigger's box in the editor.

Notes, messages and comments are templates. `{{firstName}}`, `{{name}}`, `{{headline}}`, `{{comment}}`, `{{draft}}` and `{{evaluation.reason}}` all work, as does any other field a person carries.

## What protects the account

- **Caps.** Defaults per 24 hours: 20 invites (and 100 per 7 days), 30 messages, 30 follows, 50 reactions, 15 comments, 5 reposts. Each step can change its own. The engagement defaults are cautious guesses, not measured limits. The counts come from the `actions` table, so they hold across all workflows on an account.
- **Never twice.** A person invited or messaged, a page or person followed, or a post liked, commented on or reposted from an account is skipped by every later run of every workflow. Posts are keyed by their activity id, so the same post found by two searches counts once. Something you already did by hand is recorded as `already` and skipped too.
- **Proof before counting.** An invite counts as sent only once the profile shows Pending. A message counts only once LinkedIn clears the message box. A reaction counts once the button reads pressed, a comment once its opening words appear under the post, a follow once the button reads Following, and a repost once LinkedIn shows its confirmation. Anything else is recorded as `unverified` or `failed`, and those items do not flow on to later steps.
- **LinkedIn's own limit.** If LinkedIn shows its weekly invitation limit, the Connect step stops for that run.
- **Fail loudly.** A lost session ends the run. If the first three items in a step all fail, the run ends too: that means a bad API key or stale selectors, not bad leads. An AI answer the app cannot read is an error, never a "no".
- **Human pacing.** Pauses and typing speed come from the desktop app. Camoufox moves the cursor along a human path, and each account keeps one browser fingerprint for life, because a changed fingerprint logs LinkedIn out.

## End-to-end tests

```bash
npx vite build        # once, and after any change in src/; the UI tests load dist
npm run test:e2e      # under a minute; only the UI tests open a window
```

These run the real app: the Electron main process, IPC through the preload, the runner, every step, the scheduler and the SQLite database. Only LinkedIn and the AI model are swapped for a scripted fake (`electron/adapters/fake.adapter.cjs`), so **they never open a browser, never touch a real LinkedIn account, and never call the AI endpoint**. The fake writes every invite, message, follow-up, reaction, comment, repost and follow it was asked for to a log file, and the tests check that log against what the run recorded.

They cover each starter workflow with its per-step counts; each LinkedIn action step; daily and weekly caps; never acting twice across runs, workflows and accounts; run history; Stop; Poll API against a local HTTP server; a Schedule coming due; AI prompt, Condition and Feed posts; the CRM steps, stages and follow-ups; and account rename. Failure cases each get their own launch of the app: a logged-out session, LinkedIn's weekly invite limit, actions LinkedIn never confirms, and pages that fail to load.

No `vite build` is needed. The tests drive the app through `window.outreach` on a blank page (`OUTREACH_E2E_BLANK=1`), not through the UI. Each test file gets a fresh data folder (`OUTREACH_USER_DATA`). Schedules and follow-ups come due days later, so those tests quit and relaunch on the same data with the clock moved forward (`OUTREACH_CLOCK_OFFSET_MS`), and the scheduler checks every 200 ms instead of every 30 seconds (`OUTREACH_TICK_MS`). These variables exist only for the tests.

`test/e2e/ui.test.cjs` is the exception: it launches with `launch({ ui: true })`, which loads the built renderer from `dist` (`OUTREACH_DIST=1`, no blank page), and clicks through the real screens like a person would. It covers every sidebar section opening without errors, the theme surviving a relaunch, renaming an account, running a starter workflow and finding it on the dashboard and in Run history, building a workflow in the editor by dragging connections, editing AI prompt fields and Condition rules in the inspector, setting a stage and tag in the CRM, cancelling a follow-up, and Active refusing a workflow with no Schedule trigger. It finds elements by `data-testid`, so renaming a test id in `src/` breaks it. Run `npx vite build` first, or it tests a stale UI.

A test marked TODO describes a known bug: it runs and reports, but does not fail the suite until the bug is fixed.

## Layout

```
electron/
  main.cjs, preload.cjs   window, IPC, the bridge to the editor
  runner.cjs              one run: open the account's browser, check the login, run the graph, save results
  scheduler.cjs           fires Schedule and Poll API triggers of Active workflows, and sends due follow-ups
  nodes.cjs               the step catalog: settings, kinds, and what each step does
  nodes.crm.cjs           the CRM and follow-up steps, and the sender follow-up runs use
  templates.cjs           the starter workflows
  constants.cjs           every URL, selector, pause and cap
  domain/                 pure rules, tested without a browser
    graph.cjs             validation and execution order
    engine.cjs            moves items along the arrows
    text.cjs              templates and comment word matching
    qualify.cjs           AI verdicts and remaining allowance
    aiOutput.cjs          the answer format an AI prompt asks for, and checking the answer against it
    condition.cjs         Condition rules: evaluating them on an item and finding broken ones
    linkedinData.cjs      parsing search streams, result cards and pasted links
    schedule.cjs          when a Schedule trigger fires next
    poll.cjs              which API records are new, and the items they become
    runSummary.cjs        one row per step from a run's events, stored with the run
    crm.cjs               CRM stages, the forward-only stage rule, merging a run's items into records
    followup.cjs          follow-up sequences: who can be enrolled, when the next is due, replied or not
  adapters/               everything that touches the outside world
    browser.adapter.cjs   Camoufox, one profile per account
    linkedin.adapter.cjs  driving LinkedIn pages
    llm.adapter.cjs       OpenAI-compatible chat, JSON answers
    api.adapter.cjs       fetching JSON for Poll API
    store.adapter.cjs     SQLite: accounts, workflows, runs, trigger state, the action ledger, CRM, follow-ups
    fake.adapter.cjs      scripted LinkedIn and model for the end-to-end tests
src/                      React UI on shadcn/ui and Tailwind v4, light/dark/system theme
  App.jsx                 sidebar, header, which screen shows
  pages/                  Dashboard, Workflows, WorkflowPage, WorkflowEditor (React Flow canvas), Runs, Crm, Followups, Accounts, Settings
  components/             common.jsx (badges, pipeline, item output), flow.jsx (step boxes on the canvas), ParamEditors.jsx (step settings); ui/ is shadcn's
  lib/                    runs.js (formatting runs and events), theme.jsx, utils.js
```

To add a step, add an entry to `nodes.cjs`. The editor reads the catalog over IPC, so the palette and the settings form pick it up with no UI change.

## Not yet verified on a live account

The selectors for post search, profile reading, connect without a note, and messaging come from the desktop app, where they run in production. Everything else was written without a logged-in session to check against:

- **Reading comments** on a post (`SELECTORS.COMMENT` and `readComments` in the adapter). When nothing matches, the step logs "no comments found; the comment selectors may be stale" instead of returning an empty success.
- **People search** result cards (`readPeopleCards` and `parsePersonCard`).
- **The connection note**: the Add a note button, the text box, and Send.
- **Like, comment, repost and follow**: the buttons on a single-post page, the reaction tray, the comment box, the repost menu and its toast, and Follow on company pages and profiles.
- **Reading a conversation** for follow-ups and Check replies (`SELECTORS.THREAD_*` and `readThreadEvents`), including how a message from the other person is told apart from yours. If the message list is not found, the person fails with "could not read the conversation", never "no reply". Test it on a thread where the other person has replied before trusting a sequence.
- **The home feed** (`SELECTORS.FEED_*` and `readFeedCards`). If none of the feed card selectors match, Feed posts falls back to the search-result card reader. Check that the post count in the log matches what the feed shows.

Every one of these checks LinkedIn's result before counting it, so stale selectors show up as `failed` or `unverified` in the run log, not as false successes. Try each once on a real account with the browser visible (the default), with a low cap, and adjust `constants.cjs` if anything misses.
