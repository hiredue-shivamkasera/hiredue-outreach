# Getting started

This page takes you from a fresh checkout to a finished run whose results you can read. It assumes a Mac, because the app stores the AI key in the macOS keychain and the browser setup was only tested there.

## Before you install

The app drives LinkedIn through Camoufox, a patched Firefox that looks like a normal person's browser. It does not download Camoufox itself. It uses the copy that `hiredue-desktop-application` already installed in `~/Library/Caches/camoufox`, pinned to version 152.0.4-beta.30.

That sharing has one sharp edge. camoufox-js, the library both apps use, deletes the whole `~/Library/Caches/camoufox` folder every time it fetches a browser. If this app ever fetched its own copy, it would wipe the desktop app's browser too. So it never does. When a run fails with "Camoufox 152.0.4-beta.30 is not installed", go to `hiredue-desktop-application` and run:

```bash
npm run camoufox:fetch
```

Do not run a fetch from this repo, and do not delete that cache folder by hand.

## Install and run

```bash
cd hiredue-outreach
npm install        # also downloads Electron
npm run rebuild    # builds better-sqlite3 for Electron's version of Node
npm run dev        # starts Vite and Electron with hot reload
```

`npm run rebuild` matters. better-sqlite3 is a native module, and the copy `npm install` builds is for your system Node, not Electron's. Skip it and the app crashes at startup with a "was compiled against a different Node.js version" error.

If the window never appears and the log says `app` is undefined, your shell has `ELECTRON_RUN_AS_NODE=1` set. VS Code's terminal sets it, and it makes Electron start as plain Node with no window. Clear it and start again:

```bash
unset ELECTRON_RUN_AS_NODE
npm run dev
```

`npm start` builds the UI once and runs it without hot reload, which is closer to what a teammate gets.

Everything the app stores lives in Electron's user data folder: the SQLite database `outreach.db`, and one browser profile per LinkedIn account under `accounts/<account id>/browser`.

## Connect a LinkedIn account

1. Open **Accounts** in the sidebar.
2. Type a name, for example "Shivam", and press **Add account**. The name is only a label for you.
3. Press **Log in** on the new row. A browser window opens on LinkedIn's sign-in page.
4. Sign in yourself, two-factor included. The app never sees your password. The window closes by itself once the LinkedIn feed loads. You have 5 minutes.

The row now shows "Logged in" and your profile link. The login lives in that account's browser profile, so it survives app restarts and renaming the account.

One browser fingerprint is created per account the first time it opens and is kept for life. LinkedIn treats a changed fingerprint on an existing session as a stolen cookie and logs you out, so never delete `camoufox-identity.json` from a profile folder.

## Set the AI key and calendar link

Open **Settings**.

- **Endpoint** defaults to `https://ai.hiredue.com/v1`, the HireDue LiteLLM proxy. Any OpenAI-compatible endpoint works.
- **Model** defaults to `deepseek-v4-flash`.
- **API key**: paste your LiteLLM key. The app encrypts it with the macOS keychain before writing it to the database, and the field then shows "saved". Leave the box blank later to keep the saved key.
- **Calendar link**: your booking page, for example your Topmate or Calendly link. Message templates use it as `{{calendarLink}}`. The Topmate outreach workflow refuses to send its calendar message while this is empty.
- **Run the browser hidden** is off by default. Leave it off while you are learning: a browser window opens for every run and you can watch each click.

Every AI step (AI prompt, AI qualify, AI write message, and the reply reader inside Outreach sequence) uses these settings. With no key set, those steps fail with "No LLM API key set; add one in Settings".

## Run a starter workflow

The first launch creates a few starter workflows. **B2B call qualifiers** is a good first run because it only searches, reads and invites:

1. Open **Workflows** and click **B2B call qualifiers**.
2. Choose your LinkedIn account in the account picker at the top.
3. Before the first real run, lower the risk. Press **Edit steps**, click the **Search people** step and set **Max people** to 3. Click **Send connection request** and set **Max invites per 24 hours** to 2. Press **Save**.
4. Press **Run**.

The browser opens, checks that the account is still logged in, and works through the steps. On the workflow page the left side lists runs. Click any step box while or after it runs to see what it handed on.

## Read the results

There are four places to look, from most to least detailed.

- **Run history**, then open the run. You see the workflow as it was when the run started, one row per step with how many items went in and came out, every item a step produced, everything the run did on LinkedIn (one row per invite or message, with its result), and the full log with an "Errors only" filter.
- **CRM, People.** When a run ends, every person it handed between steps is filed here, one record per account and profile. Each record has a stage, tags, notes, the AI's score if a step scored them, and a timeline.
- **Accounts, History** on an account row. Every invite, message, follow, reaction, comment and repost this account made, newest first. These rows are what the daily caps count.
- **Dashboard.** Runs today, invites and messages sent in the last 24 hours, people who replied, Active workflows, recent runs, and the latest people found.

A result of `sent` means LinkedIn confirmed it. `unverified` or `failed` means it did not, and those people do not flow on to later steps. [concepts.md](concepts.md) explains every status.

## Next

- [concepts.md](concepts.md) for how runs, caps and the CRM work.
- [building-workflows.md](building-workflows.md) to make your own.
- [topmate-workflows.md](topmate-workflows.md) before you switch on the Topmate workflows.
