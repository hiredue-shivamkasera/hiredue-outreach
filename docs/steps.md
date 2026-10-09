# Steps

Every step in the editor's palette, in the palette's order. For each: what it takes in, what it hands on, every setting with its default, and the things that trip people up.

"Takes" and "gives" are item kinds (trigger, person, post, page), explained in [concepts.md](concepts.md#item-kinds). "Same" means it hands on whatever kind it received.

Steps that act on LinkedIn (invite, message, follow, react, comment, repost) all share three behaviours, so they are not repeated under each one:

- They skip a target this account already acted on, in any workflow, and log "done from this account before, skipped".
- They stop when the account's cap for that action is used up, and log "allowance used up; the rest wait for the next run".
- They hand on only items LinkedIn confirmed as `sent`. Everything else is in the ledger and the run's "Done on LinkedIn" list but goes no further.

## Triggers

### Start

Where a run begins when you press Run.

- Takes nothing. Gives one trigger.
- No settings.

### Schedule

Fires on its own while the workflow is Active and the app is open.

- Takes nothing. Gives one trigger.

| Setting | Default | Notes |
|---|---|---|
| Every (minutes, 15 or more) | 240 | below 15 is raised to 15 |
| From hour (0-23) | 9 | local time |
| Until hour (1-24) | 19 | a run never starts at or after this hour |
| Days | Monday to Friday | or Every day, or Saturday and Sunday |
| Random shift (± minutes) | 20 | each fire moves by up to this much either way |

Gotchas:

- It never fires the moment you switch Active on. It waits for its first slot.
- A slot that falls outside the hours moves to the start of the next allowed window, plus a little random delay, never earlier than "From hour".
- If From hour is not below Until hour, the window becomes the whole day.
- Saving the workflow or toggling Active resets the next fire time.

### Poll API

Checks a JSON API on a timer while the workflow is Active. Each record it has not seen before becomes an item.

- Takes nothing. Gives person, page or post, set by "The links are".

| Setting | Default | Notes |
|---|---|---|
| API URL | (required) | |
| Headers as JSON | blank | for example `{"Authorization": "Bearer abc"}` |
| Path to the list in the answer | blank, meaning the answer itself is the list | dotted path, such as `data.leads` |
| Field holding the LinkedIn link | `linkedinUrl` | |
| Field that identifies a record | blank, meaning the link | |
| The links are | People | or Company or school pages, or Posts |
| Check every (minutes, 5 or more) | 30 | below 5 is raised to 5 |
| Max new records per run | 25 | the rest stay unseen and come next time |

Gotchas:

- It checks as soon as you switch it on, then every N minutes. An API with nothing new never opens the browser.
- Records are marked as seen only once their run has started. If the account is busy, they wait for the next check.
- The other fields in each record ride along, so a note can use `{{note}}` or any column the API sends.
- Headers, API keys included, are stored in plain text in the local database.
- Pressing Run polls once, right then.

## Search

### Search posts

LinkedIn's post search.

- Takes a trigger. Gives posts.

| Setting | Default |
|---|---|
| Keywords | `hiring` (required) |
| Date posted | Past week. Also Past 24 hours, Past month, Any time |
| Sort by | Latest. Also Top match |
| Max posts | 20 |

The log says how many posts have a link later steps can open. A post without one cannot be liked, commented on or read for commenters.

### Search people

LinkedIn's people search. It can filter people on the search page itself, so nobody's profile is opened just to be rejected.

- Takes a trigger. Gives people, with `name`, `headline`, `location`, `degree`, `profileUrl`, `firstName`, and `snippet` (the "Current:", "Past:" or "Summary:" lines LinkedIn shows under some results).

| Setting | Default | Notes |
|---|---|---|
| Keywords | `founder B2B` (required) | |
| Connection | 2nd degree | 1st degree, 3rd degree and beyond, or Anyone |
| Headline or search snippet must mention | blank, meaning anyone | comma-separated; whole words, any case |
| Skip people the CRM shows as already contacted | Yes | skips anyone whose CRM stage is past New, or who already has an invite in the ledger |
| Max people to keep | 20 | counted after filtering |
| Max result pages to read | 10 | stops paging here even if fewer were kept |

Gotchas:

- "Max people to keep" counts people who passed the filters. With a narrow filter, the step reads up to 10 pages to find them.
- Word matching respects word edges: `mentor` does not match inside `mentorship`. List both if you want both.
- The result card reader is not yet verified on a live account. Check the count in the log against what the search page shows.

### LinkedIn URLs

A fixed list of links you paste in.

- Takes a trigger. Gives person, page or post, set by "The links are".

| Setting | Default |
|---|---|
| Links, one per line | (required) |
| The links are | Company or school pages |

A link of the wrong kind is logged as skipped. Duplicates are dropped.

## Feed

### Feed posts

Scrolls this account's home feed and collects posts, skipping ads.

- Takes a trigger. Gives posts.
- Setting: Max posts, default 20.

The feed card selectors are not verified on a live account. If none match, the step falls back to the search result card reader. Check the count in the log against what the feed shows.

## Posts

### Post commenters

Opens each post, loads its comments, and keeps people whose comment contains one of your words.

- Takes posts. Gives people, each with `comment` (what they wrote) and `source.postText`.

| Setting | Default |
|---|---|
| Comment contains (comma-separated, blank = everyone) | `interested` |
| Max comments read per post | 50 |

Matching respects word edges, so `interested` does not match "uninterested". The comment selectors are not verified; if nothing matches, the log says "no comments found; the comment selectors may be stale" instead of returning zero quietly.

### Like post

Reacts to each post.

- Takes posts. Gives the posts it reacted to.

| Setting | Default |
|---|---|
| Reaction | Like. Also Celebrate, Support, Love, Insightful, Funny |
| Max reactions per 24 hours | 50 |

A post you already reacted to by hand comes back `already`. Proof of `sent` is the button reading pressed.

### Comment on post

Posts a comment under each post, once per post per account.

- Takes posts. Gives the posts it commented on, with `commented` holding the text.

| Setting | Default |
|---|---|
| Comment | `{{draft}}` (required) |
| Max comments per 24 hours | 15 |

Pair it with AI write message before it. `{{authorFirstName}}` works. Proof of `sent` is the comment's first 40 characters appearing under the post.

An `unverified` comment counts as done, because it may have posted: later runs skip that post rather than risk commenting twice. Open the post to check if you need to.

### Repost

Reposts each post to your feed.

- Takes posts. Gives the posts it reposted.

| Setting | Default |
|---|---|
| Your thoughts (blank = plain repost; `{{draft}}` works) | blank |
| Max reposts per 24 hours | 5 |

Proof is LinkedIn's "repost successful" message. As with Comment on post, an `unverified` repost counts as done so it is never posted twice.

## Profile

### Visit profile

Opens each profile and reads it.

- Takes people. Gives the same people with `headline`, `location`, `degree`, `about` and `experience` filled in.
- No settings.

Run this before AI steps. The AI judges only from what the item carries, and a search card has no About or Experience.

### Follow

Follows company or school pages, people, or the authors of posts.

- Takes pages, people or posts. Gives what it followed.
- Setting: Max follows per 24 hours, default 30.

Proof is the button reading Following. Something you already follow comes back `already`.

### Send connection request

Sends an invite, with or without a note.

- Takes people. Gives the people it invited, with `invitedWith` holding the note or `null`.

| Setting | Default | Notes |
|---|---|---|
| Note | blank, meaning no note | `{{firstName}}`, `{{draft}}` and any field work; 300 characters at most |
| Add the note | When the account can (otherwise send without) | or Always (skip the person if it cannot), or Never |
| Max invites per run | blank, meaning no run limit | |
| Vary the per-run limit by ± | 0 | |
| Max invites per 24 hours | 20 | |
| Max invites per 7 days | 100 | |
| Wait between invites, at least (seconds) | 3 | |
| Wait between invites, at most (seconds) | 6 | |

Gotchas:

- The allowance for a run is the smallest of: what is left of the daily cap, what is left of the weekly cap, and the per-run limit. With per-run 8 and vary ±2, each run picks a number from 6 to 10. The log's first line says which number it got.
- Free LinkedIn accounts get a few personalised notes a month. When "Add a note" leads to the Premium upsell, the app remembers it for 7 days (`LIMITS.NOTE_RECHECK_DAYS`). With "When the account can", invites in that time go without a note and the log says so. With "Always", those people are recorded `unverified` with "this account cannot add a note right now; nothing was sent".
- A note over 300 characters fails that person before anything is clicked.
- A profile already showing Pending is `pending`; a 1st-degree connection is `connected`; a profile with no Connect option is `unavailable`. None of these count against the cap.
- If LinkedIn shows its weekly invitation limit, the step records `limit` and stops for this run.
- The wait applies only after an invite LinkedIn accepted, and not after the last one.

## Messaging

### Send message

Messages 1st-degree connections.

- Takes people. Gives the people it messaged, with `messaged` holding the text.

| Setting | Default |
|---|---|
| Message | `Hi {{firstName}}, {{draft}}` (required) |
| Max messages per 24 hours | 30 |

Gotchas:

- It never writes into a conversation that already has messages. Those people come back `already_messaged`, which also counts as done, so a later run will not try them.
- Someone who is not 1st degree comes back `not_connected`.
- Proof of `sent` is LinkedIn clearing the message box after Send.

### Follow-up sequence

Books follow-up messages for people this account already messaged. It sends nothing itself.

- Takes people. Gives the people it enrolled.

| Setting | Default |
|---|---|
| Follow-up messages | two: after 3 days "Hi {{firstName}}, just following up on my last message.", after 7 more days "Hi {{firstName}}, one last nudge from me." |
| Stop when they reply | Yes |
| Max follow-ups per 24 hours | 20 |

Each message goes its number of days after the one before; the first counts from the original message. Only someone with a `sent` message from this account can be enrolled, and a person has at most one active sequence per account. While the app is open, the scheduler sends due follow-ups every 30 seconds whether or not the workflow is Active. A conversation it cannot read is retried in 6 hours, and after 3 tries the row is marked failed. An `unverified` send marks the row failed rather than retrying, because a retry could send twice.

There is no longer a Follow-ups page in the app, so you cannot see or cancel these rows from the UI. For new work, use Outreach sequence below, which keeps its state on each CRM person, and also handles the invite, the replies and the calendar link.

### Check replies

Opens each person's conversation and splits them by whether they wrote back after this account's last message.

- Takes people. Gives `replied` and `noReply`, both the same people. Replied people carry `reply` with their latest message.
- No settings.

A replied person is marked Replied in the CRM, and any Follow-up sequence for them stops. A conversation that cannot be read fails that person ("could not tell whether they replied"); it is never counted as "no reply". The conversation reader is not verified on a live account.

### Outreach sequence

Runs each person through a whole conversation: wait for the invite to be accepted, send an intro, two follow-ups, then drop; and answers replies. Interested people get your calendar link; a booking or a no closes them; anything else waits for you. It stops for anyone you have answered by hand.

It keeps its state on the person's CRM record, so put it after **From CRM** on a **Schedule**. Each run moves each person at most one step on. [topmate-workflows.md](topmate-workflows.md) walks through the states with a diagram.

- Takes people. Gives four outputs, all people:
  - `sent`: a message went out this run, with `outreach.sentKind` (`intro`, `followup1`, `followup2`, `calendar`) and the text;
  - `needsYou`: they replied with something the AI sorted as "other", or a send came back `unverified`;
  - `waiting`: nothing to do yet (invite not accepted, or the next follow-up is not due);
  - `closed`: finished this run (booked, not interested, dropped, invite never accepted, or handled by you).

| Setting | Default |
|---|---|
| Intro message, sent once they accept (no calendar link) | "Hi {{firstName}}, thanks for connecting! Would love to hear what you are working on." (required) |
| Follow-up 1 (blank = none) | "Hi {{firstName}}, just bumping this in case it got buried." |
| Follow-up 2 (blank = none) | "Hi {{firstName}}, one last nudge from me. No worries if now is not a good time." |
| Message with your calendar link | "Great, {{firstName}}! Here is my calendar, pick any slot that works for you: {{calendarLink}}" (required, must contain `{{calendarLink}}`) |
| Days to wait for a reply before each follow-up | 2 (at least 1) |
| Look at each person at most every (hours) | 6 |
| Stop waiting for an invite to be accepted after (days) | 21 |
| How the AI should read a reply | "Read the person's reply to our LinkedIn outreach and say what they mean." (required) |
| Max messages per run | 15 |
| Max messages per 24 hours (intro, follow-ups and calendar together) | 40 |
| Wait between messages, at least (seconds) | 20 |
| Wait between messages, at most (seconds) | 60 |

What it does with one person, in order:

1. Skips them if they are finished, or if they were looked at less than "every (hours)" ago.
2. **First time it sees someone**, it works out where they start from the ledger. An invite on record means "Invite sent". Already 1st degree with no invite means "Connected, intro due". A message this account sent outside the sequence means "Handled by you": the sequence stays out of a conversation it did not start.
3. **Invite sent:** opens the profile. 1st degree now means accepted. Not 1st degree after 21 days means "Invite never accepted", closed.
4. Opens the conversation. Empty and connected: sends the intro. If the last message from your side is not one the sequence sent, you answered by hand: "Handled by you", closed. If they have written since your last message: the AI reads the reply.
5. **The AI sorts the reply** into exactly one of `interested`, `booked`, `not_interested` or `other`, with a one-sentence reason. Interested: sends the calendar message. Booked: closed, stage Meeting booked. Not interested: closed, stage Lost. Other: "Replied, needs you". An interested reply after the calendar link already went also goes to "needs you", so you never send the link twice.
6. **No reply yet:** sends follow-up 1 once 2 days have passed since the last message, follow-up 2 two days later, and two days after that drops them (stage Dropped). A blank follow-up is skipped.

Gotchas:

- Every send is checked like Send message: it counts only once LinkedIn clears the message box. The intro is never written into a conversation that already has messages; that person becomes "Handled by you".
- An `unverified` send moves the person to "Replied, needs you" with a note to check the conversation, because sending the next message on top of one that may have gone out would double up.
- The intro is recorded in the ledger as `message`, the rest as `followup`. The 40-a-day cap counts both actions across the whole account, so Send message steps in other workflows use the same allowance.
- A conversation it cannot read fails that person for this run and is tried again after the check interval. It is never taken as "no reply".
- An AI answer outside the four classes is an error for that person, not a guess, and is retried on the next look.
- If someone is interested and Settings has no calendar link, that person fails with "no calendar link is set; add one in Settings and the next run sends it". Nothing is sent, and the next run sends it once the link is there.
- You can stop, resume, mark booked or drop anyone by hand from their panel in CRM, People.

## CRM

### From CRM

Starts from people already in the CRM for this workflow's account, newest activity first.

- Takes a trigger. Gives people, with the CRM's saved data and `crm.stage`, `crm.tags`.

| Setting | Default |
|---|---|
| Stage | Any stage |
| Tag (blank = any) | blank |
| Max people | 25 |

Only people filed under this workflow's account appear. Fields earlier runs learned, such as an AI score, come along.

### Update CRM

Sets a stage, adds tags or writes a note on each person's record, as if you had done it by hand. Passes everyone on.

- Takes people. Gives the same people.

| Setting | Default |
|---|---|
| Set stage | (leave as is) |
| Add tags (comma-separated) | blank |
| Note | blank; `{{firstName}}`, `{{evaluation.reason}}` and any field work |

Unlike the automatic stage rule, this can move a person backwards, because it counts as a choice you made.

## AI

All AI steps use the endpoint, model and key in Settings. If the first three items all fail, for example because the key is wrong, the step stops the run.

### AI prompt

Asks the model your own question about each item and stores the answer in fields you define.

- Takes anything. Gives the same items with the answer stored under "Store the answer as".

| Setting | Default |
|---|---|
| Prompt | "Is {{firstName}} likely to buy B2B sales software? Score the fit and give the reason." (required) |
| Answer fields | `score` (number, "0-100 fit") and `reason` (text, "one sentence") |
| Store the answer as | `ai` |

Each answer field has a name, a type and a description. Types: `number` (a quoted `"82"` is read as 82), `boolean` (only `true` or `false`; `"yes"` is rejected), `choice` (one of a list you give, matched ignoring case), `text` (any non-empty text). Names use letters, digits and `_`.

An answer missing a field, or with the wrong type, fails that item with the field named. No default is filled in, because a blank score would look like a low score.

### AI qualify

A yes or no with a score, against criteria you write.

- Takes anything. Gives `pass` and `fail`, the same items with `evaluation.qualified`, `evaluation.score` and `evaluation.reason`.

| Setting | Default |
|---|---|
| Who qualifies? | "Qualifies if this person runs or leads a B2B business and would plausibly take a sales call." (required) |
| Minimum score (0-100) | 70 |

Passing needs the model to say qualified and give a score at or above the minimum. An answer it cannot read fails that item, never "fail".

### AI write message

Writes a note for each person, or a comment for each post. Later steps use it as `{{draft}}`.

- Takes people or posts. Gives the same items with `draft`.

| Setting | Default |
|---|---|
| What should the message say? | "Write a warm two-sentence note. Mention what they said in their comment, and offer to share details. No emojis, no hashtags." (required) |
| Max characters | 300 |

A draft over the limit fails that item rather than being cut off mid-sentence.

## Logic

### Condition

Sends each item out True or False by rules on its fields. No AI, no cost.

- Takes anything. Gives `true` and `false`.
- Setting: Rules. Default: `ai.score` at least 70, all rules must hold.

Each rule is a field, a test and a value. The field is a dotted path such as `ai.fit_score`, `headline` or `evaluation.score`. Tests: equals, not equals, contains, does not contain, greater than, less than, at least, at most, is true, is false, is empty, is not empty. Pick whether all rules or any rule must hold.

- Numbers compare as numbers, so `"100"` is above `"70"`. Text compares ignoring case.
- A rule on a field the item does not have is false, except "is empty". A person the AI never scored goes out False.
- Broken rules, such as "at least" with no number, show in the editor and block the run.

### Keyword filter

Splits items by whether one field contains one of your words. No AI.

- Takes anything. Gives `pass` and `fail`.

| Setting | Default |
|---|---|
| Field | Headline. Also Their comment, About, Experience, Location, Post text, Connection degree |
| Contains any of (comma-separated) | (required) |
