# HireDue Outreach docs

HireDue Outreach is a desktop app that runs LinkedIn outreach on your own logged-in LinkedIn accounts. You build a workflow by joining steps on a canvas, for example "search people, read their profiles, let the AI score them, invite the good ones", and the app runs it in a real browser, clicking the way a person would. It checks every invite and message actually went through, keeps per-account daily caps, never contacts the same person twice, and files everyone it touches into a small CRM where you can see who accepted, who replied, and who needs you.

## Where to start

| Doc | Read it if you | What it covers |
|---|---|---|
| [getting-started.md](getting-started.md) | are opening the app for the first time | install, log in a LinkedIn account, set the AI key and calendar link, run a starter workflow, read the results |
| [concepts.md](concepts.md) | want to know why the app did what it did | workflows, steps, item kinds, triggers, runs, the action ledger, caps, never-twice, verification statuses, CRM stages, outreach states |
| [steps.md](steps.md) | are building or editing a workflow | every step, what it takes and gives, every setting and its default, gotchas |
| [building-workflows.md](building-workflows.md) | want to make your own workflow | the editor, message templates and placeholders, the AI prompt plus Condition pattern, schedules, safe limits, testing |
| [topmate-workflows.md](topmate-workflows.md) | run the Topmate mentor outreach | the two built-in Topmate workflows, what happens to each person, what to customise, what to check in the CRM |
| [architecture.md](architecture.md) | will change the code, or are a coding agent | processes, folders, the engine, runner and scheduler, database tables, the fake LinkedIn, adding a step, tests, what is unverified |

Founders and ops: getting-started, concepts, building-workflows, topmate-workflows. Developers: all of the above, then architecture.

## Three rules worth knowing before your first run

1. **Caps are per account, across all workflows.** 20 invites a day and 100 a week by default. A second workflow on the same account shares the same allowance.
2. **Only `sent` counts.** The app looks for LinkedIn's own proof (the profile shows Pending, the message box clears). Anything else is recorded as `unverified` or `failed` and goes no further.
3. **Do not fetch Camoufox from this repo.** The browser is shared with `hiredue-desktop-application`, and fetching it wipes the shared copy. See [getting-started.md](getting-started.md#before-you-install).
