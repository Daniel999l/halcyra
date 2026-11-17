"""
The native gamepad feeder: one virtual Xbox 360 controller at OS level.

Node (src/native/pad.js) starts this and writes one JSON line per update to
stdin. Every number is already in XInput terms (Node does the conversion):

  {"lx":0.12,"ly":-0.5,"rx":0,"ry":0,"lt":0,"rt":0.8,"btn":["Y","RB"]}

  lx, ly, rx, ry  sticks, floats -1..1, y positive = UP (XInput convention)
  lt, rt          triggers, floats 0..1
  btn             names of the buttons held: A B X Y LB RB START BACK LS RS
                  UP DOWN LEFT RIGHT GUIDE (any not listed are released)

Rules it keeps:
  - prints "ready" (one line, flushed) once the pad exists
  - a bad line is reported on stderr and skipped, never a crash
  - EOF, SIGTERM, SIGINT or any exit: the pad goes back to neutral first

Built on the `vgamepad` pip package (it bundles ViGEmClient; on Windows its
installer also installs the ViGEmBus driver).

  python feeder.py          the real pad (needs vgamepad + ViGEmBus)
  python feeder.py --dry    no pad: echoes each applied state as JSON on stdout
                            (used by the tests on Linux and by native-check)
"""
import json
import signal
import sys

DRY = "--dry" in sys.argv[1:]

NAMES = ["A", "B", "X", "Y", "LB", "RB", "START", "BACK", "LS", "RS",
         "UP", "DOWN", "LEFT", "RIGHT", "GUIDE"]


def clamp(v, lo, hi):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return 0.0
    if v != v:  # NaN
        return 0.0
    return lo if v < lo else hi if v > hi else v


class DryPad:
    """stand-in with vgamepad's method names, prints what a real pad would get"""

    def __init__(self):
        self.s = {"lx": 0.0, "ly": 0.0, "rx": 0.0, "ry": 0.0, "lt": 0.0, "rt": 0.0, "btn": []}
        self.held = set()

    def left_joystick_float(self, x_value_float, y_value_float):
        self.s["lx"], self.s["ly"] = x_value_float, y_value_float

    def right_joystick_float(self, x_value_float, y_value_float):
        self.s["rx"], self.s["ry"] = x_value_float, y_value_float

    def left_trigger_float(self, value_float):
        self.s["lt"] = value_float

    def right_trigger_float(self, value_float):
        self.s["rt"] = value_float

    def press_button(self, button):
        self.held.add(button)

    def release_button(self, button):
        self.held.discard(button)

    def reset(self):
        self.__init__()

    def update(self):
        self.s["btn"] = [n for n in NAMES if n in self.held]
        sys.stdout.write("state " + json.dumps(self.s, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def make_pad():
    if DRY:
        return DryPad(), {n: n for n in NAMES}
    import vgamepad as vg  # noqa: E402  (imported here so --dry needs nothing)
    B = vg.XUSB_BUTTON
    table = {
        "A": B.XUSB_GAMEPAD_A, "B": B.XUSB_GAMEPAD_B, "X": B.XUSB_GAMEPAD_X, "Y": B.XUSB_GAMEPAD_Y,
        "LB": B.XUSB_GAMEPAD_LEFT_SHOULDER, "RB": B.XUSB_GAMEPAD_RIGHT_SHOULDER,
        "START": B.XUSB_GAMEPAD_START, "BACK": B.XUSB_GAMEPAD_BACK,
        "LS": B.XUSB_GAMEPAD_LEFT_THUMB, "RS": B.XUSB_GAMEPAD_RIGHT_THUMB,
        "UP": B.XUSB_GAMEPAD_DPAD_UP, "DOWN": B.XUSB_GAMEPAD_DPAD_DOWN,
        "LEFT": B.XUSB_GAMEPAD_DPAD_LEFT, "RIGHT": B.XUSB_GAMEPAD_DPAD_RIGHT,
        "GUIDE": B.XUSB_GAMEPAD_GUIDE,
    }
    return vg.VX360Gamepad(), table


def neutral(pad):
    try:
        pad.reset()
        pad.update()
    except Exception as e:  # the pad may already be gone
        sys.stderr.write("neutral failed: %s\n" % e)


def apply(pad, table, held, line):
    m = json.loads(line)
    if not isinstance(m, dict):
        raise ValueError("not an object")
    pad.left_joystick_float(x_value_float=clamp(m.get("lx", 0), -1, 1), y_value_float=clamp(m.get("ly", 0), -1, 1))
    pad.right_joystick_float(x_value_float=clamp(m.get("rx", 0), -1, 1), y_value_float=clamp(m.get("ry", 0), -1, 1))
    pad.left_trigger_float(value_float=clamp(m.get("lt", 0), 0, 1))
    pad.right_trigger_float(value_float=clamp(m.get("rt", 0), 0, 1))
    want = set()
    btn = m.get("btn", [])
    if isinstance(btn, list):
        for b in btn:
            b = str(b).upper()
            if b in table:
                want.add(b)
    for b in held - want:
        pad.release_button(button=table[b])
    for b in want - held:
        pad.press_button(button=table[b])
    pad.update()
    return want


def main():
    try:
        pad, table = make_pad()
    except Exception as e:
        sys.stderr.write("error: could not create the virtual pad: %s\n" % e)
        sys.stderr.flush()
        return 2

    def bye(*_):
        neutral(pad)
        sys.exit(0)

    signal.signal(signal.SIGTERM, bye)
    signal.signal(signal.SIGINT, bye)
    if hasattr(signal, "SIGBREAK"):  # Windows Ctrl+Break
        signal.signal(signal.SIGBREAK, bye)

    neutral(pad)
    sys.stdout.write("ready\n")
    sys.stdout.flush()
    held = set()
    bad = 0
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                held = apply(pad, table, held, line)
            except Exception as e:
                bad += 1
                if bad <= 20 or bad % 1000 == 0:
                    sys.stderr.write("bad line %d skipped: %s\n" % (bad, str(e)[:120]))
                    sys.stderr.flush()
    finally:
        neutral(pad)
        if DRY:
            sys.stdout.write("neutral\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
