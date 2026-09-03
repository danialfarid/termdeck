# The README demos

The README shows two focused demos: the multi-agent terminal workflow and the Files/Git workflow. Each is built
from a raw screen recording by
[`tools/build_demo.py`](../tools/build_demo.py). Nothing about the pacing or GIF conversion is hand-edited, so
each demo can be regenerated independently.

## Where the recordings live

Source recordings are **not in the repo** — they are larger than the README assets and only the built clips are
versioned. They sit in the demo project's own data directory:

```
~/data/termdeck-evently-demo/
├── termdeck-evently-terminals-demo.webm    1680x900, 206s   multi-agent terminal workflow
└── termdeck-evently-files-git-demo.webm    1680x900,  64s   project files and Git workflow
```

The recordings carry their own burnt-in captions ("Caption: Ask the agent for a change"), which is why the build
never crops or overlays anything.

Built output, committed:

```
docs/media/demo-opening.webm    1680x900, 64s, ~5.6 MB   full resolution, linked under the player
docs/media/demo-opening.gif     700px,    64s, ~6.2 MB   what the README actually shows
docs/media/demo-terminals.webm  1680x900, 93s,  ~8.9 MB  multi-agent terminal workflow
docs/media/demo-terminals.gif   700px,    93s,  ~9.7 MB  GitHub-compatible terminal workflow
docs/media/demo-files-git.webm  1680x900, 26s,  ~3.1 MB  Files/Git workflow
docs/media/demo-files-git.gif   700px,    26s,  ~3.4 MB  GitHub-compatible Files/Git workflow
```

## Rebuilding it

```sh
python3 tools/build_demo.py --out docs/media/demo-terminals \
    ~/data/termdeck-evently-demo/termdeck-evently-terminals-demo.webm

python3 tools/build_demo.py --out docs/media/demo-files-git \
    ~/data/termdeck-evently-demo/termdeck-evently-files-git-demo.webm

python3 tools/build_demo.py --plan-only <inputs...>   # print the cut plan, encode nothing
```

Requires `ffmpeg`. The full run takes a few minutes, almost all of it VP9 encoding.

## Why the README shows a GIF

GitHub's README sanitizer **drops `<video>` entirely**. A `<video src=…>` tag renders as an
empty paragraph — the page showed nothing but the fallback link. An `<img>` survives, and
GitHub animates a GIF as long as it is not too large, marking it `data-animated-image` in the
rendered HTML. That is the whole reason for a 6 MB GIF next to a smaller webm.

To check what GitHub really does with a README change:

```sh
gh api -H "Accept: application/vnd.github.html" repos/danialfarid/termdeck/readme \
  | grep -o '<img[^>]*demo[^>]*>'
```

GIF settings (700px / 6fps / 48 colours) are chosen to stay under the size where GitHub
stops animating while keeping terminal text legible — verify by pulling a frame back out of
the finished GIF, not by trusting the source:

```sh
ffmpeg -ss 10 -i docs/media/demo-opening.gif -frames:v 1 /tmp/check.png
```

Removing dead air makes a GIF *bigger*, not smaller: fewer near-identical frames means less
for the encoder to collapse. The first pass at the old settings came out 8.9 MB.

## How the pacing works

A terminal recording is mostly still. Measured on these two segments, **~80% of sampled
frames differ from the previous one by almost nothing** — a dialog sitting open, an agent
thinking, output that has stopped. Playing that at 1x wastes the viewer's time; speeding
everything up uniformly destroys the moments that carry the meaning.

So the speed follows the content. Every 0.2s the mean difference between consecutive frames
is measured (`tblend=all_mode=difference` into `signalstats`, on a 320px copy — the profile
only needs relative change). Each sample is classified by that number and gets its own speed:

| Class | Frame difference | Speed | Why |
|---|---|---|---|
| **burst** | ≥ 4.0 | **1.0x** | a click, a menu opening, a drag — the things worth watching |
| **typing** | 0.6 – 4.0 | 1.5x | characters appearing, output streaming in |
| **still** | < 0.6 | 4.5x | dialog open, waiting on an agent, nothing moving |

Two rules keep it watchable rather than merely short:

- **A burst is padded** by one sample either side, so a click keeps its lead-in and
  follow-through instead of starting mid-motion.
- **A still stretch never falls below 0.35s** of screen time however long it was. Dead air
  collapses, but a pause still reads as a pause instead of a jump cut.

Contiguous samples of one class become one cut. Each cut is a `trim` with its own
`setpts=(PTS-STARTPTS)/speed`, and the cuts are `concat`-ed back together — 125 of them for
the current demo. The result: **148s of recording becomes 64s, with every click and drag
intact at full speed.**

## Tuning

The constants at the top of `tools/build_demo.py` are the whole control surface:

- `STILL` / `BURST` — the thresholds between the three classes.
- `SPEEDS` — the multiplier per class. Raising `typing` past ~1.6x starts to make streaming
  output hard to follow.
- `STILL_MIN_OUTPUT` — raise it if the cut feels jumpy, lower it for a shorter clip. This is
  the dominant lever on total length, because there are far more still stretches than
  anything else: at 0.35s and ~60 stretches per segment it accounts for most of the output.
- `BURST_PAD_SAMPLES` — raise it if clicks feel clipped.

Run with `--plan-only` after changing any of them; it prints the cut count and projected
length per input in a couple of seconds, without encoding anything.

## Recording a new segment

Keep the burnt-in caption convention (`Caption: <what this step shows>`) — it is the only
narration, and the pacing assumes captions span a whole step, whose actions stay at 1x and
therefore keep their reading time. Record at whatever resolution suits; the build normalises
everything to 1680x900, so mixed sizes across segments are fine (the two current segments
were captured at 3360x1800 and 1680x900).
