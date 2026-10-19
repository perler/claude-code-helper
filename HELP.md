# Claude Code Helper: cheat sheet

## 1. Queue buttons (New Task view)

| Button | Queue |
|---|---|
| 📅 Today | your tasks due today or overdue |
| ⏳ Input | tasks waiting on your input |
| 📥 Both | the two above as one queue |
| 📁 project | one project, walked in a single inbox-zero session |
| ✉️ Mail | your inbox: one mail, or several at a time |

A queue button opens a checklist. ▶ on a row opens that task now, in its own session and tab; ↗ opens it in Asana. Tick tasks, then 💬 (title bar) walks them in one inbox-zero session — nothing ticked walks the whole queue — or ☰ (or OK) puts them into the Queue view, a session each **without a tab**.

✉️ Mail works the other way round: click a row (or Enter) to open that mail now, ☐ on the right ticks it, ↗ opens it in Gmail, and 💬 works the ticked mails in one triage session. One ticked is routed like a single mail; nothing ticked triages the whole inbox.

⚡ Quick Session (title bar, beside refresh and help) starts a session straight away in a new ~/tasks/YYYY-MM-DD-HHMM folder: no prompt, no routing, for a question that belongs to no client or project. The folder takes the session's title once it ends.

Recent Sessions, right-click a row: Resume and Compact (only on sessions that are not running: resumes it and runs `/compact`, to keep working on the same job with room again) and Start New Session Here (a fresh session in that row's folder, for a clean context; the old session is left alone). Favourites and Recent Sessions share one layout: on hover ▶ new session, ↻ resume, 📂 reveal the folder; right-click has the same Run and Folder groups (terminal, reveal, new window, copy folder path), then the session or favourite specifics.

## 2. Queue view

One row per task. Click a row to attach a tab to its session. Closing the tab of a working or asking session leaves it running. Closing the tab of a finished session ends it and removes its row; resume it from Recent Sessions if you need it again. The cross on a row closes its tab as well.

| State | Meaning |
|---|---|
| `? asking` | the session wants an answer from you |
| `! finished` | a turn ended and you have not looked yet |
| `needs folder` | the task could not be placed; click the row and pick its folder |
| `* working` | busy |
| `queued` | waiting for a free slot (at most five sessions work at once) |
| `seen` | finished and you have looked |
| `ended` | the session's process is gone; resume it from Recent Sessions |
| `could not start` | the start failed; click the row to try again |

The number on the view is how many rows are asking or finished. Right-click a row: Open Asana Task, Remove from List. "Clear finished" in the view title removes ended rows. The list is shared between all windows.

Each session first checks whether its task is still real and asks before closing it.

## 3. Tab badges

`*` working, `?` asking, `!` finished and not looked at yet.

## 4. Unlocking a task session

A session that works an Asana task cannot change remote systems while the task carries the `readonly` tag. Instead of removing the tag in Asana, type into the session:

| You type | What happens |
|---|---|
| `unlock` | removes `readonly`, opens the lock, counts as your go-ahead |
| `unlock, deploy it` | the same; everything after the word is your instruction |
| `unlock carefully` | also removes `⚠️ read carefully`; plain `unlock` leaves such a task locked |

`unlock` must be the first word of the message. Removing the tag in Asana still works and takes up to a minute.

A task born from an email also locks credential files. That lock lifts by itself while you are attached; if it does not, run `bridge-unlock <task folder>` in a terminal.

## 5. Tab right-click menu

Show Live Session Panel, Open Asana Task, Reveal Session Folder.
