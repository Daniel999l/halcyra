# The console probe (a short test on the game page)

This is a small test you run on your own PC against the page the game plays in
(any page that runs the game). It opens Chrome, you start the game,
and then it checks three things by itself:

1. Can we **see** the game picture?
2. Does the game **listen** to our pretend controller?
3. How **slow** is it from a button press to the picture changing?

It writes down everything it finds in a folder.

## Once, before you start

Open a terminal (PowerShell or Command Prompt) in the project folder and run:

```
npm install
```

That is all. It uses the Google Chrome you already have. It downloads no browser.

## Running it

1. In the project folder, run (use the real address of the game service):

   ```
   node scripts/console-probe.mjs https://the-game-page-address
   ```

2. A Chrome window opens. In it:
   - log in to the game service (the login is remembered for next time),
   - start the game,
   - wait until you see a **still screen** (a menu or the pause screen). Stay there.
3. Go back to the terminal and press **Enter**.
4. Click once on the **top bar** of the Chrome window (where the tab name is,
   not on the game) so Chrome is in front.
5. Now **do not touch** the mouse, keyboard or your controller for about
   2 minutes. The probe only ever presses left and right (D-pad, left stick,
   and the arrow keys), so it cannot buy, delete or confirm anything.
   It clicks the picture once only if it has to test the arrow keys.
6. When it prints the summary, end your game session in Chrome yourself,
   then press **Enter** in the terminal to close Chrome.

If anything goes wrong, press **Ctrl+C** in the terminal. It still saves what it
found so far.

## What the lines mean

| line | PASS means | FAIL means |
|---|---|---|
| PICTURE | we found the game picture and can read it | we cannot see it (black, blocked, or not found) |
| CONTROLLER | the game moved when our pretend controller pressed left/right | it did not react to the pretend controller |
| KEYBOARD | (only tested if CONTROLLER did not pass) it reacted to the arrow keys instead | it did not react to keys either |
| DELAY | a number: how long from a press to the picture changing, on your home internet. The server will get its own number | |
| PAGE | not pass or fail: facts about how the page works | |

**UNCLEAR** means the picture kept moving by itself (a video or a game was
showing), so it could not tell. Go back to a still menu screen and run it again.

The last line, **Next step**, tells you in one sentence what to do next.

## Where the report goes

Everything is saved in a new folder inside the project:

```
data/probe-<date and time>/
```

(`report.txt`, `report.json` and a few pictures).

## If Chrome will not open

The probe looks for Google Chrome (then Microsoft Edge). If it says it cannot
find Chrome, set its path before running:

```
set CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe       (Command Prompt)
$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"   (PowerShell)
```

If Google refuses to log you in inside this window, log in to the game service with email
and password instead.
