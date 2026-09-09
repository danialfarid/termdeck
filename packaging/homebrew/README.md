# Homebrew packaging

TermDeck ships through a personal tap, [`danialfarid/homebrew-tap`](https://github.com/danialfarid/homebrew-tap):

```sh
brew install danialfarid/tap/termdeck
```

The tap is a separate repository that holds only `Formula/termdeck.rb`. That formula is generated from this
directory.

## Why a tap, and why wheels

A personal tap has no notability gate (homebrew-core does) and behaves identically for users. Moving to
homebrew-core later requires the separate source-build candidate described below and maintainer review.

The formula installs TermDeck's Python dependencies from **prebuilt CPython 3.13 wheels**, not from source.
This is the important decision. A source build would compile `pydantic-core` from Rust (via
`maturin`/`setuptools-rust`) plus C extensions, and Homebrew's install sandbox has no network — so every
build backend would also have to be vendored, and every user would wait through a Rust build. Installing from
wheels means **nothing compiles at install time**: fast, and far fewer ways to break.

Packages with native extensions are architecture-specific, so their wheels live in per-arch
`on_arm`/`on_intel` blocks. The generator resolves every dependency for both architectures and classifies the
downloaded wheel instead of relying on a hard-coded package list. The rest are universal `py3-none-any` wheels.
This makes the formula **macOS-only** (Apple Silicon + Intel); Linux users install with `uv`/`pipx` from the
GitHub release.

TermDeck itself is built from the uploaded GitHub release source archive, not the automatic Git tag archive
(it is pure Python, so `hatchling` — installed
from its own wheel first — is all that is needed).

The install and upgrade commands are unchanged. Downloads of this source archive appear in GitHub's release-asset
counters. Those are download events, not unique installs or active users: CI and upgrades add events, while caches
can avoid a download. No usage reporting is added to the application.

## Generating the formula

Run **after** the `vX.Y.Z` release source archive is uploaded (the generator hashes the archive and resolves the
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

Each tagged release updates the tap through `.github/workflows/release.yml`. For a manual repair:

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

## Homebrew core candidate

`core/termdeck.rb` is the reviewed source-formula candidate for the published release. It is separate from
the generated wheel formula used by the existing tap. `generate_core_formula.py` resolves the specified
published release, rather than the working checkout, using Python 3.14. It downloads each selected source
archive and verifies its PyPI SHA-256 before emitting pinned resources. It fails if a source archive is
missing or yanked. Dependency resolution happens at generation time; Homebrew installs those resources
with its standard `Language::Python::Virtualenv` helper and dependency resolution disabled.

The candidate uses Homebrew's `pydantic` and `certifi`, including the Python modules provided by pydantic,
instead of bundling them. Remaining dependencies use source archives on both macOS and Linux. Rust is a
build dependency for source backends that require it. The formula test checks dependency compatibility,
starts an isolated HTTP server on an available port with a temporary data directory, verifies an empty
session list and the packaged UI, then terminates only that test server.

Regenerate after a stable tag is published, review the resulting dependency diff, and retain the generated
formula so builds do not re-resolve dependencies:

```sh
python3.14 packaging/homebrew/generate_core_formula.py 0.11.1 > packaging/homebrew/core/termdeck.rb
brew tap-new termdeck/core-check
cp packaging/homebrew/core/termdeck.rb "$(brew --repository termdeck/core-check)/Formula/termdeck.rb"
brew install --build-from-source termdeck/core-check/termdeck
brew test termdeck/core-check/termdeck
brew audit --strict --online termdeck/core-check/termdeck
brew audit --new termdeck/core-check/termdeck
```

`.github/workflows/homebrew-core.yml` supplies a manually triggered macOS/Linux source-build, functional-test,
and strict online-audit matrix for an existing release. It does not publish to the tap. The additional
`--new` audit remains a submission gate, including popularity; do not suppress it for a core PR.

### Remaining submission gates

- Obtain the public-interest evidence required by Homebrew's package acceptance policy.
- Complete successful source builds and audits on the supported macOS/Linux CI matrix. Local generation
  and checksum verification alone do not establish that a formula builds in Homebrew's sandbox.
- Confirm the release is explicitly stable. `pyproject.toml` currently advertises Beta; change that only
  when the release is actually declared stable, then publish a new immutable tag.
- Recheck self-update handling before submission: an in-progress updater currently hardcodes
  `danialfarid/tap/termdeck`. A core install must remain managed by core, and any conflicting self-update
  operation must be disabled or route through the installed Homebrew formula.
- Audit bundled browser assets and their licenses/source provenance (see `NOTICE`); justify vendoring
  where Homebrew cannot provide a supported substitute.
- Check `brew update-python-resources` compatibility for the eventual submitted formula; TermDeck is
  distributed from GitHub and must not resolve an unrelated same-named PyPI project.
- Homebrew requires disclosure of AI assistance, human review before requesting maintainer review,
  and human responses to maintainer questions.

Policy references: [Python packaging](https://docs.brew.sh/Language-Specific-Formulae),
[formula acceptance](https://docs.brew.sh/Acceptable-Formulae), and
[submission guide](https://docs.brew.sh/How-To-Open-a-Homebrew-Pull-Request).

### Validation on 2026-09-08

Generated the v0.11.1 candidate and verified the release checksum and all 15 PyPI source archive checksums.
Ruby syntax, Python lint, workflow YAML parsing, and `brew style --formula` in a temporary tap passed.
The host audit stopped because its Command Line Tools do not support macOS 26. Validation then ran in the
existing `job-browser` Tart VM: macOS 15.7.7, Apple Silicon, Homebrew 6.0.22, Python 3.14.7, with no previous
Homebrew TermDeck installation. A separate uv installation was subsequently confirmed, so that VM was not
a clean-machine baseline. Tests explicitly used the Homebrew executable and isolated data directories.
The v0.11.1 source formula installed successfully, including all 15 source resources;
declared Homebrew dependencies used their normal bottles. A rebuild after the fixes below also passed.

- `brew test termdeck/core-check/termdeck` passed: CLI version, isolated server startup, empty sessions API,
  packaged JavaScript, and Python dependency compatibility.
- `brew style --formula` and `brew audit --strict --online` passed.
- An additional installed-app smoke test created a disposable zsh session, attached through WebSocket,
  sent resize/input messages, and verified command output from the dtach-backed shell.
- Test sessions and servers were stopped. The VM retains the installed candidate and build dependencies;
  the host's live server and sessions were not changed.

The VM exposed two formula issues: Ruby spawn redirection requires the log path as a string, and inheriting
global Python packages polluted dependency checks with an unrelated broken `wheel` installation. The
template and candidate now use a string log path and disable system site packages while retaining the
explicit Homebrew dependency paths.

The clean Ubuntu ARM64 source build also exposed GCC 13's native-CPU pointer-authentication miscompilation:
importing `setproctitle` terminated with SIGILL, and disassembly showed `autiasp` followed by `retaa`.
This matches [GCC bug 119372](https://gcc.gnu.org/pipermail/gcc-bugs/2025-March/905786.html).
A baseline ARMv8-A rebuild verified the cause and passed startup, but Homebrew's audit rejected the
runtime-detection helper used for that diagnostic build. The candidate instead declares GCC 14 and older
incompatible on Linux ARM64 using Homebrew's compiler-selection mechanism and declares Homebrew GCC as
a build dependency there. This retains normal build hardening and selects a fixed compiler (GCC 16.2.0
in the verified build). macOS and x86 builds are unchanged. Both the
generated candidate and generator template contain this compiler requirement.

### Clean-machine follow-up

Two disposable VMs were created separately from `job-browser` and checked before installing:

| VM | Initial state | Verified results |
| --- | --- | --- |
| `termdeck-macos-install-check`, macOS 15.7.7 ARM64 | No TermDeck executable, Homebrew formula, uv executable/tool environment, or TermDeck data directory | Source installation and shell smoke passed; uninstall removed the executable; fresh reinstall, `brew test`, and shell smoke passed again |
| `termdeck-linux-install-check`, Ubuntu 24.04.4 ARM64 | Neither Homebrew nor TermDeck installed | Installed Homebrew and build prerequisites; final source formula built with GCC 16.2.0; shell smoke, `brew test`, dependency check, and strict online audit passed |

Both test VMs are stopped and retained for repeat checks. Their test data was isolated and disposable;
the original VM's uv installation and running work were left alone. The existing public tap was not updated.

The reusable installed-package smoke check is also part of the packaging workflow:

```sh
"$(brew --prefix termdeck)/libexec/bin/python" packaging/homebrew/smoke_installed.py "$(brew --prefix)/bin/termdeck"
```

It starts an isolated server, fetches the installed UI, creates a disposable bash session, checks real
WebSocket input/output, and stops the test server and its exact dtach session. It does not use live data.

These checks establish installation and backend functionality on macOS ARM64 and Linux ARM64, not browser
visual behavior, authenticated agent workflows, Intel macOS, or x86-64 Linux. The GitHub-hosted CI workflow
and `--new` submission audit remain outstanding; passing the strict audit does not establish core acceptance.
