# Releasing

The steps to cut a TermDeck release. Only the maintainer needs this.

## One-time setup

### PyPI

1. Create the project token at <https://pypi.org/manage/account/token/>.
   For the very first release the project doesn't exist yet, so create an **account-scoped** token, publish
   once, then replace it with a project-scoped one.
2. Add it to the repository: **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `PYPI_API_TOKEN`
   - Value: the `pypi-…` token
3. Create an environment named `release` (**Settings → Environments**). The workflow references it, and it
   gives you a place to require manual approval later if you want one.

### Homebrew tap

```sh
gh repo create danialfarid/homebrew-tap --public --description "Homebrew tap for termdeck"
```

See [packaging/homebrew/README.md](packaging/homebrew/README.md) for the details.

---

## Cutting a release

### 1. Update the version and changelog

```sh
# termdeck/__init__.py
__version__ = "0.2.0"
```

Move everything under `## [Unreleased]` in `CHANGELOG.md` into a new `## [0.2.0] — YYYY-MM-DD` section and
update the link definitions at the bottom.

### 2. Verify locally

```sh
ruff check .
python -m build && python -m twine check dist/*

python3 -m venv /tmp/termdeck-verify
/tmp/termdeck-verify/bin/pip install dist/termdeck-0.2.0-py3-none-any.whl
/tmp/termdeck-verify/bin/termdeck --version
/tmp/termdeck-verify/bin/termdeck doctor
TERMDECK_PORT=8532 TERMDECK_DATA_DIR=/tmp/termdeck-verify-data /tmp/termdeck-verify/bin/termdeck
# open http://127.0.0.1:8532, create a terminal, run a command, restart the server, confirm it resumes
```

### 3. Commit and tag

```sh
git add -A && git commit -m "Release 0.2.0"
git tag v0.2.0
git push && git push --tags
```

The tag push triggers `.github/workflows/release.yml`, which:

1. builds the sdist and wheel and runs `twine check`
2. fails the build if the tag doesn't match `termdeck/__init__.py`
3. publishes to PyPI using `PYPI_API_TOKEN`
4. creates the GitHub release with both artifacts attached

Watch it: `gh run watch`.

### 4. Verify the published package

```sh
uv tool install termdeck==0.2.0     # or: pipx install termdeck==0.2.0
termdeck --version
```

### 5. Update the Homebrew tap

Only after PyPI has the release, since the formula hashes the published sdist.

```sh
python packaging/homebrew/generate_formula.py
cp packaging/homebrew/termdeck.rb ../homebrew-tap/Formula/termdeck.rb
cd ../homebrew-tap && git add -A && git commit -m "termdeck 0.2.0" && git push
```

Then confirm from a clean state:

```sh
brew update
brew install danialfarid/tap/termdeck
termdeck doctor
```

---

## Versioning

[Semantic versioning](https://semver.org/). While the major version is `0`:

- **patch** (`0.1.0` → `0.1.1`) — bug fixes, docs
- **minor** (`0.1.0` → `0.2.0`) — new features, and any breaking change

Things that count as breaking for this project: renaming or removing a `TERMDECK_*` variable or CLI flag,
changing the data directory layout, or changing the on-disk format of `sessions.json` without a migration.

## If a release goes wrong

PyPI does not allow re-uploading a version, even after deletion. Bump the patch version and release again —
yanking the bad one (`pip`'s "yank" on the PyPI web UI) hides it from new resolutions without breaking anyone
who already pinned it.
