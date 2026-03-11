# Activity Tracker

Activity tracker is a personal productivity tracker. It consists of:

* A node.js script intended to be run continually while working. This polls the active window every second and logs to a daily log file every time the active window title changes.
* A config JSON with regex patterns for each different category of work that you'd like to track
* A set of patterns for window titles that are ambiguous, but you should "infer the previous category" (i.e. "visual studio code", "command prompt", "open file", "save as", "node.js", "stack overflow")
* Categories can be flagged as "secondary", in which case they are only used if there is no matching primary category. This is useful for things like "Slack" that might match a primary category (depending on the channel name), but should be logged to a backup/catch-all category if they don't match a primary category.
* If the `DAYCAST_DATA_DIR` env var is populated, the script also queries your local Daycast SQLite DB every second to sum up the minutes clocked against projects that you're particularly interested in. These are associated with categories via a `daycast_project_id` attribute on the category.
* Running `npm run serve` will fire up a local http server. Navigating to this in a browser will show a horizontal bar, similar to Wakatime, that shows the categories tracked throughout your day. Clicking on a category bar will reveal the details of active window titles for that bar below.

# To-Do

* Simplify to 2min granularity, so the UI is usable and investigable
  * Algorithm: iterate log & convert it to a full list of all contiguous CATEGORY blocks (omitting actual window titles)
  * Make a list of tiny category blocks that are <2min
  * Sort tiny category block list by duration with smallest first
  * For each item in the list, look it up in the full list of category blocks
  * Verify that it is still <2min (it may no longer be, due to changes since the initial scan)
  * If it is, remove it from the full list and add its time to the block before it
  * If the block after it is the same category as the block before it, join these into a single, longer, block
  * Ideally we would simplify the data structure & data to just the coarse-grained data, while retaining the fine-grained data just-in-case (hidden in the UI but visible in the log files)
* Idle tracking (mouse & keyboard), writes movement to separate input-activity file
* Read from this on the client, based on a threshold, mark time in the "idle" category
* Show it in red if it's below `"focus_goal: 0.90"` and green if it's equal or above

# UI adjustments

* Make color scheme less jarring
* Add borders & put in a "bars" placeholder div
* On hover, replace a "details" div with details for a bin
* On click of close icon (bootstrap?), replace details with day-wide summary
* On left/right-arrow keypress, navigate days or bins
