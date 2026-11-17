# NATIVE: the game on a Windows PC

The game runs as a normal Windows program on a Windows PC with an NVIDIA GPU
(Windows Server 2025 or Windows 11). The Node service runs on that same PC. There is no browser tab.

`CONSOLE_KIND=native` switches the service to this:

| part | how | file |
|---|---|---|
| pad | a virtual Xbox 360 controller at OS level (ViGEmBus driver), held by a small Python program (`vgamepad`). Node writes one JSON line per update to it | `src/native/pad.js`, `src/native/feeder.py` |
| eye | ONE ffmpeg grabs the desktop (ddagrab, gdigrab if that fails) and writes 160 x 90 rgb24 frames, 10 a second. Node keeps only the newest one and turns it into her grid with the same function the browser eye uses | `src/native/screen.js` |
| `/api/frame.jpg` | the same ffmpeg also writes a 640 px JPEG once a second | `src/native/screen.js` |
| stream | a second ffmpeg grabs the desktop, H.264 (h264_nvenc, else libx264) + AAC to RTMP, 1280x720 30 fps, 2500 kbps, keyframe every 2 s | `src/stream.js` |
| console | ties those together, same interface as the browser tab; no browser is started | `src/native/console.js` |

Her brain, taste, ledger and proof are unchanged. A tick in native mode is the
same record as in browser mode (checked: same seed + same picture gives the
identical tick through both paths).

## Steps on the PC

Do these in order, logged in to the PC's desktop.

1. **Get the code** onto the PC (for example `C:\halcyra`).

2. **Run the setup script** in an admin PowerShell (right click PowerShell, Run as administrator):
   ```
   cd C:\halcyra
   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
   ```
   It installs what is missing: Node LTS, Python 3, ffmpeg (full build with
   ddagrab and NVENC), `vgamepad` and the ViGEmBus driver (silently: running
   it means you accept the ViGEmBus licence), turns on Windows Audio, and runs
   `npm ci`. Running it again is safe. If it says to, reboot and run it again.
   Then **close that PowerShell and open a new one** so the new PATH is used.

3. **Stop the PC from sleeping or locking** (admin PowerShell):
   ```
   powercfg /change monitor-timeout-ac 0
   powercfg /change standby-timeout-ac 0
   ```
   and turn off the screen saver. A locked or sleeping screen gives a black picture.

4. **Set the Windows display to 1280 x 720** (Settings > System > Display >
   Display resolution).

5. **Install GTA V** and start it once. In the game's settings:
   - Display mode (Screen type): **Windowed Borderless**
   - Resolution: **1280 x 720**
   - **Pause Game On Focus Loss: Off**

   Why: the eye and the stream grab the whole desktop, so the game must cover
   all of it and nothing else may be on top. Borderless (not exclusive
   fullscreen) lets Windows' desktop capture see every frame; exclusive
   fullscreen can black out or stall the capture. 1280 x 720 is the stream
   size, so nothing is scaled and the GPU has less to do. "Pause on focus
   loss" off keeps the game running if a window pops up.

6. **Run the self-test** with the game open (a new, normal PowerShell):
   ```
   cd C:\halcyra
   node scripts\native-check.mjs
   ```
   Every line must say PASS. It saves `data\native-check.png` (what she sees,
   160 x 90) and `data\native-check.jpg`: open them and check the game is on them.
   While it runs, "Set up USB game controllers" (`joy.cpl`) shows an Xbox 360
   controller.

7. **Check the pad in the game by hand** (service not running):
   ```
   node scripts\pad.mjs press START
   node scripts\pad.mjs hold LY 1 2000     (walks forward for 2 s)
   node scripts\pad.mjs hold LX -1 1000    (left)
   node scripts\pad.mjs hold RT 0.6 2000   (gas in a car)
   node scripts\pad.mjs seq A 500 DOWN 300 A
   node scripts\pad.mjs neutral
   ```
   Use it to get through the menus into Story Mode and into a car.
   Then click once into the game window and leave keyboard and mouse alone
   (GTA switches its prompts to whichever device moved last).

8. **Set the env values.** Make a file named `.env` in `C:\halcyra` (or set
   them in PowerShell) with:
   ```
   CONSOLE_KIND=native
   MONGO_URI=...
   TOKEN_CA=...
   STREAM_URL=rtmp://.../<stream key>
   ```
   `CONSOLE_URL` is not used in native mode. Every other setting has a
   default; the native ones are listed in README.md (`PYTHON`, `PAD_FEEDER`,
   `PAD_HZ`, `CAPTURE`, `EYE_FPS`, `FRAME_FPS`, `FRAME_W`, `FRAME_PIPE`,
   `STALE_MS`, `STREAM_INPUT`, `STREAM_ENCODER`, `STREAM_AUDIO`).

9. **Start the service** in a normal PowerShell window on the desktop and
   leave it open:
   ```
   cd C:\halcyra
   npm start
   ```
   It must run in the logged-in desktop session, not as a Windows service
   (a service has no desktop to grab). `/api/health` on port 8080 shows the
   console state (`playing` when frames come in) and the stream state.

## Leaving the PC

If you reach the PC over Remote Desktop (RDP), do NOT just close the RDP
window: Windows then locks that session and the picture goes black. Instead,
before leaving, run this in an admin Command Prompt; it hands the session back
to the PC's own screen and drops your RDP connection:
```
for /f "skip=1 tokens=3" %s in ('query user %USERNAME%') do %windir%\System32\tscon.exe %s /dest:console
```
If the provider gives its own remote viewer, closing that viewer is fine as
long as the screen stays unlocked. Check with `/api/frame.jpg` from outside.

## Sound on the stream

The stream always has an audio track (pump.fun's RTMP ingest may refuse a
stream without one). With `STREAM_AUDIO=auto` it uses game sound if a
loopback capture device is installed, else silence.

To get game sound: install **VB-Audio Virtual Cable** (vb-audio.com/Cable),
then in Windows Sound settings make **"CABLE Input"** the default playback
device. The service finds **"CABLE Output"** and streams it. (A cloud PC
often has no sound card at all; the cable also gives the game a device to play
into.) Other devices it picks up by name: "Stereo Mix", "virtual-audio-capturer".
To force one: `STREAM_AUDIO=dshow:<exact device name>`; to force silence:
`STREAM_AUDIO=silent`. List devices: `ffmpeg -list_devices true -f dshow -i dummy`.

## Exact formats

Pad line (Node -> feeder, one per update, at most `PAD_HZ` a second, the
newest wins, an unchanged state is repeated once a second):
```
{"lx":0.12,"ly":0.5,"rx":0,"ry":0,"lt":0,"rt":0.8,"btn":["Y"]}
```
Sticks -1..1 in XInput terms (Y up = +1; the browser pad's Y is down = +1, so
Node flips Y). Triggers 0..1 from buttons 6/7. A button is held at value
>= 0.5. Names: A B X Y LB RB START BACK LS RS UP DOWN LEFT RIGHT GUIDE.
The feeder prints `ready` once the pad exists, skips bad lines, and resets
the pad to neutral on end of input or exit. If it dies, Node starts it again
(0.5 s doubling to 30 s) and resends the newest state.

Eye frame: 160 x 90 x 3 bytes rgb24, scaled by ffmpeg's `area` filter (a box
average), turned into her grid by `gridFromPixels()` from `src/eye.js`:
Rec. 709 luminance 0..1, Float32Array of 14,400, row by row. If the eye
ffmpeg dies, it is started again (1 s doubling to 30 s); if ddagrab gives no
frame, gdigrab is tried.
