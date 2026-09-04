#!/usr/bin/env python3
"""Join demo recordings into one clip, paced to what is happening on screen.

A screen recording of a terminal is mostly still: measured on the two TermDeck
segments, ~80% of frames differ from the one before by almost nothing -- a dialog
sitting open, an agent thinking, output that has stopped. Playing that at 1x wastes
the viewer's time, and speeding the whole thing up uniformly ruins the moments that
carry the meaning: a click, a menu opening, a terminal dragged into a group.

So the speed follows the content. Every SAMPLE_STEP seconds the frame difference is
measured, each moment is classified from it, and each class gets its own speed:

    click / menu / drag   1.0x   plus a beat either side, so it stays readable
    text appearing        1.5x   typing, output streaming in
    still frame           4.5x   but never shorter than STILL_MIN_OUTPUT

Usage:
    python3 tools/build_demo.py --out docs/media/demo-opening \\
        ~/data/termdeck-evently-demo/segment-1-opening.keep.webm \\
        ~/data/termdeck-evently-demo/segment-2-fanout.webm

    python3 tools/build_demo.py --plan-only <inputs...>   # print the cut plan, encode nothing

Writes <out>.webm (full resolution) and <out>.gif (what GitHub can actually play --
its README sanitizer drops <video> tags entirely, so the front page needs an image).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

SAMPLE_STEP = 0.2        # how often the frame difference is measured, in seconds
STILL = 0.6              # mean frame difference below this: the screen is not changing
BURST = 4.0              # above this: a click, a menu, a drag -- never speed it up
SPEEDS = {"burst": 1.0, "typing": 1.5, "still": 4.5}
BURST_PAD_SAMPLES = 1    # samples of 1x lead-in and follow-through around a burst
STILL_MIN_OUTPUT = 0.35  # a pause keeps this much screen time, so it reads as a pause
ANALYSIS_FPS = 5         # sampling rate for the motion profile (1 / SAMPLE_STEP)
ANALYSIS_WIDTH = 320     # the profile only needs relative change, not detail

# The GIF is what renders on GitHub. 1200px keeps terminal text legible at README width; 4fps is
# what pays for it (the same clip at 6fps is a third larger, and the pacing pass already spends
# time only where things move). The palette is built from the WHOLE clip, not from what changes
# between frames: a dark terminal is almost entirely greys, and a diff-weighted palette spent its
# slots on anti-aliased text edges and quantised every accent -- cyan identifiers, the red
# permission banner, green paths -- to grey. The saturation lift before quantising gives those few
# accent pixels enough weight to keep their palette entries.
GIF_WIDTH, GIF_FPS, GIF_COLORS, GIF_SATURATION = 1200, 4, 64, 1.5


def run(argv: list[str]) -> None:
    subprocess.run(argv, check=True)


def probe(path: str, entries: str) -> str:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", entries,
                          "-of", "default=noprint_wrappers=1:nokey=1", path],
                         capture_output=True, text=True, check=True)
    return out.stdout.strip()


def motion_profile(path: str, work: str, index: int) -> list[tuple[float, float]]:
    """Mean luma of each frame minus the one before it, sampled ANALYSIS_FPS times a second."""
    report = os.path.join(work, f"motion-{index}.txt")
    run(["ffmpeg", "-y", "-i", path, "-vf",
         f"fps={ANALYSIS_FPS},scale={ANALYSIS_WIDTH}:-2,tblend=all_mode=difference,"
         f"signalstats,metadata=print:key=lavfi.signalstats.YAVG:file={report}",
         "-an", "-f", "null", "-", "-loglevel", "error"])
    return [(float(t), float(v)) for t, v in re.findall(
        r"pts_time:([\d.]+)\s*\nlavfi\.signalstats\.YAVG=([\d.]+)", open(report).read())]


def classify(samples: list[tuple[float, float]]) -> list[str]:
    kinds = ["still" if v < STILL else ("burst" if v >= BURST else "typing") for _, v in samples]
    # A click is worth watching slightly before and after the frame that detected it.
    padded = list(kinds)
    for i, kind in enumerate(kinds):
        if kind == "burst":
            lo = max(0, i - BURST_PAD_SAMPLES)
            hi = min(len(kinds), i + BURST_PAD_SAMPLES + 1)
            padded[lo:hi] = ["burst"] * (hi - lo)
    return padded


def cut_plan(samples: list[tuple[float, float]], duration: float) -> list[tuple[float, float, float]]:
    kinds = classify(samples)
    runs: list[list] = []
    for (time, _), kind in zip(samples, kinds, strict=True):
        if runs and runs[-1][0] == kind:
            runs[-1][2] = time
        else:
            runs.append([kind, max(0.0, time - SAMPLE_STEP), time])
    if runs:
        runs[-1][2] = duration
    plan = []
    for kind, start, end in runs:
        length = max(SAMPLE_STEP, end - start)
        speed = SPEEDS[kind]
        if kind == "still" and length / speed < STILL_MIN_OUTPUT:
            speed = max(1.0, length / STILL_MIN_OUTPUT)
        plan.append((start, end, round(speed, 3)))
    return plan


def render_segment(path: str, plan: list[tuple[float, float, float]], width: int, height: int,
                   fps: int, target: str) -> None:
    """One trim per cut, each with its own setpts, concatenated back together."""
    parts, labels = [], []
    for i, (start, end, speed) in enumerate(plan):
        parts.append(f"[0:v]trim=start={start:.3f}:end={end:.3f},"
                     f"setpts=(PTS-STARTPTS)/{speed:.3f}[v{i}];")
        labels.append(f"[v{i}]")
    graph = ("".join(parts) + "".join(labels) + f"concat=n={len(plan)}:v=1:a=0[cat];"
             f"[cat]scale={width}:{height}:flags=lanczos,fps={fps}[out]")
    run(["ffmpeg", "-y", "-i", path, "-filter_complex", graph, "-map", "[out]", "-an",
         "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", target, "-loglevel", "error"])


def write_gif(source: str, target: str, work: str) -> None:
    palette = os.path.join(work, "palette.png")
    frames = f"fps={GIF_FPS},scale={GIF_WIDTH}:-1:flags=lanczos,eq=saturation={GIF_SATURATION}"
    run(["ffmpeg", "-y", "-i", source, "-vf",
         f"{frames},palettegen=max_colors={GIF_COLORS}:stats_mode=full", palette, "-loglevel", "error"])
    run(["ffmpeg", "-y", "-i", source, "-i", palette, "-lavfi",
         f"{frames}[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle", target, "-loglevel", "error"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("inputs", nargs="+", help="recordings to join, in order")
    parser.add_argument("--out", default="docs/media/demo-opening",
                        help="output path without extension (default: %(default)s)")
    parser.add_argument("--width", type=int, default=1680)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--fps", type=int, default=25)
    parser.add_argument("--plan-only", action="store_true", help="print the cut plan and stop")
    args = parser.parse_args()

    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            print(f"{tool} is required (brew install ffmpeg)", file=sys.stderr)
            return 1

    work = tempfile.mkdtemp(prefix="termdeck-demo-")
    rendered, total_in, total_out = [], 0.0, 0.0
    try:
        for index, path in enumerate(args.inputs, start=1):
            path = os.path.expanduser(path)
            duration = float(probe(path, "format=duration"))
            size = probe(path, "stream=width,height").split()
            plan = cut_plan(motion_profile(path, work, index), duration)
            out_length = sum((end - start) / speed for start, end, speed in plan)
            at_full = sum(end - start for start, end, speed in plan if speed <= 1.01)
            total_in, total_out = total_in + duration, total_out + out_length
            print(f"{os.path.basename(path)}: {'x'.join(size)}  {duration:.0f}s -> {out_length:.0f}s  "
                  f"({len(plan)} cuts, {at_full:.0f}s of clicks and drags kept at 1x)")
            if args.plan_only:
                print("  " + json.dumps(plan[:6]) + (" …" if len(plan) > 6 else ""))
                continue
            target = os.path.join(work, f"fast-{index}.webm")
            render_segment(path, plan, args.width, args.height, args.fps, target)
            rendered.append(target)

        print(f"total: {total_in:.0f}s -> {total_out:.0f}s")
        if args.plan_only:
            return 0

        listing = os.path.join(work, "concat.txt")
        with open(listing, "w") as handle:
            for path in rendered:
                handle.write(f"file '{path}'\n")
        webm = f"{args.out}.webm"
        os.makedirs(os.path.dirname(webm) or ".", exist_ok=True)
        merged = os.path.join(work, "merged.webm")
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", merged,
             "-loglevel", "error"])
        run(["ffmpeg", "-y", "-i", merged, "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0",
             "-row-mt", "1", "-an", webm, "-loglevel", "error"])
        write_gif(merged, f"{args.out}.gif", work)
        for produced in (webm, f"{args.out}.gif"):
            print(f"wrote {produced} ({os.path.getsize(produced) / 1e6:.1f} MB)")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
