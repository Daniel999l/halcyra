#!/bin/sh
# Start a virtual display, then hand the container over to the app.
#
# This replaces xvfb-run, which is wrong for a container entrypoint in two ways
# that together produced a container that started and then said nothing at all:
#
#   1. It does not exec. The app ends up as a CHILD of a shell script, so the
#      script is PID 1: it gets the signals, the app does not, and log capture
#      depends on a stream the app does not own.
#   2. Its --server-args value contains spaces. In an exec-form ENTRYPOINT that
#      is one argv element, but a platform that re-serialises the start command
#      through a shell splits it, and "1440x900x24" becomes the command to run.
#
# Here Xvfb goes to the background, the app is exec'd so it BECOMES PID 1, and
# there is no argument string left to mangle.
set -e

DISPLAY_NUM="${DISPLAY_NUM:-99}"
SCREEN="${SCREEN:-1280x720x24}"  # = the browser window = what the stream grabs

Xvfb ":${DISPLAY_NUM}" -screen 0 "${SCREEN}" -nolisten tcp -noreset >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
export DISPLAY=":${DISPLAY_NUM}"

# Wait for the socket rather than sleeping a guessed number of seconds. If it
# never appears, say so loudly instead of letting Chromium fail later with
# something unrelated-looking.
i=0
while [ ! -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "FATAL: Xvfb did not come up on :${DISPLAY_NUM} after 10s" >&2
    cat /tmp/xvfb.log >&2 || true
    exit 1
  fi
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "FATAL: Xvfb died on startup" >&2
    cat /tmp/xvfb.log >&2 || true
    exit 1
  fi
  sleep 0.1
done

echo "display ${DISPLAY} is up (${SCREEN})"
exec "$@"
