# Homebrew packaging

TermDeck ships through a personal tap, [`danialfarid/homebrew-tap`](https://github.com/danialfarid/homebrew-tap):

```sh
brew install danialfarid/tap/termdeck
```

The tap is a separate repository that holds only `Formula/termdeck.rb`. That formula is generated from this
directory.

## Why a tap, and why wheels

A personal tap has no notability gate (homebrew-core does) and behaves identically for users. Moving to
homebrew-core later is just a formula submission.

The formula installs TermDeck's Python dependencies from **prebuilt CPython 3.13 wheels**, not from source.
This is the important decision. A source build would compile `pydantic-core` from Rust (via
`maturin`/`setuptools-rust`) plus C extensions, and Homebrew's install sandbox has no network — so every
build backend would also have to be vendored, and every user would wait through a Rust build. Installing from
wheels means **nothing compiles at install time**: fast, and far fewer ways to break.

The cost: the four packages with native extensions — `pydantic-core`, `setproctitle`, `watchdog`,
`websockets` — are architecture-specific, so their wheels live in per-arch `on_arm`/`on_intel` blocks. The
rest are universal `py3-none-any` wheels. This makes the formula **macOS-only** (Apple Silicon + Intel);
Linux users install with `uv`/`pipx` from the GitHub release.

TermDeck itself is still built from the GitHub release tarball (it is pure Python, so `hatchling` — installed
from its own wheel first — is all that is needed).

## Generating the formula

Run **after** the `vX.Y.Z` tag exists on GitHub (the generator hashes the release tarball and resolves the
exact dependency set):

```sh
python packaging/homebrew/generate_formula.py           # version from termdeck/__init__.py
python packaging/homebrew/generate_formula.py 0.2.0     # or an explicit version
```

It resolves the dependency set in a throwaway virtualenv, downloads the matching cp313 wheels for both
architectures, looks each up on PyPI for its URL and sha256, and writes `packaging/homebrew/termdeck.rb`
(gitignored — it belongs in the tap, not here).

## Publishing to the tap

One-time:

```sh
gh repo create danialfarid/homebrew-tap --public --description "Homebrew tap for termdeck"
```

Each release:

```sh
python packaging/homebrew/generate_formula.py
cp packaging/homebrew/termdeck.rb ../homebrew-tap/Formula/termdeck.rb
cd ../homebrew-tap && git add -A && git commit -m "termdeck 0.1.0" && git push
```

## Testing the formula

The most reliable checks that don't need a full build:

```sh
ruby -c Formula/termdeck.rb                          # syntax
brew tap danialfarid/tap
brew fetch danialfarid/tap/termdeck                  # downloads + verifies every resource checksum
brew install danialfarid/tap/termdeck                # the real thing
brew test termdeck
```

`brew fetch` validates the tarball and all wheel resources (URLs + sha256) without compiling anything, so it
is the fastest way to catch a bad hash or a moved wheel.

## Notes

- Bump `PYTHON_FORMULA` / `PYTHON_TAG` / `ABI` in `generate_formula.py` together when Homebrew's default
  Python moves to a new minor version — the pinned wheels are ABI-specific (`cp313`).
- The `service do` block enables `brew services start termdeck` as an alternative to
  `termdeck service install`.
- `brew audit --strict` will flag the wheel-based install as non-standard. That is expected for this tap and
  is the deliberate trade for an install that never compiles.
