# Releasing

The steps to cut a TermDeck release. Only the maintainer needs this.

TermDeck is distributed two ways, both from GitHub — there is no PyPI package (yet):

- **Homebrew** (macOS): the [`danialfarid/homebrew-tap`](https://github.com/danialfarid/homebrew-tap) formula.
- **uv / pipx** (everywhere): installed straight from the GitHub release tag.

## One-time setup

The Homebrew tap repository:

```sh
gh repo create danialfarid/homebrew-tap --public --description "Homebrew tap for termdeck"
```

That's it — no PyPI account or token is needed for the current flow.

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
```

### 3. Commit, tag, and push

`main` is branch-protected, so land the version bump through a PR, then tag the merged commit:

```sh
git switch -c release-0.2.0 && git commit -am "Release 0.2.0" && git push -u origin release-0.2.0
gh pr create --fill && gh pr merge --squash --admin       # review, then merge
git switch main && git pull
git tag v0.2.0 && git push --tags
```

Pushing the tag triggers `.github/workflows/release.yml`, which builds the sdist and wheel, checks the tag
matches `termdeck/__init__.py`, and creates the GitHub release with both artifacts attached. Watch it with
`gh run watch`.

### 4. Verify the git install

```sh
uv tool install --force "git+https://github.com/danialfarid/termdeck.git@v0.2.0"
termdeck --version
```

### 5. Update the Homebrew tap

Only after the tag exists — the formula hashes the release tarball.

```sh
python packaging/homebrew/generate_formula.py
cp packaging/homebrew/termdeck.rb ../homebrew-tap/Formula/termdeck.rb
cd ../homebrew-tap && git add -A && git commit -m "termdeck 0.2.0" && git push
```

Then confirm from a clean state (`brew fetch` verifies every wheel checksum without compiling):

```sh
brew update
brew fetch danialfarid/tap/termdeck
brew install danialfarid/tap/termdeck
termdeck doctor
```

See [packaging/homebrew/README.md](packaging/homebrew/README.md) for how the wheel-based formula works.

---

## Versioning

[Semantic versioning](https://semver.org/). While the major version is `0`:

- **patch** (`0.1.0` → `0.1.1`) — bug fixes, docs
- **minor** (`0.1.0` → `0.2.0`) — new features, and any breaking change

Breaking, for this project: renaming or removing a `TERMDECK_*` variable or CLI flag, changing the data
directory layout, or changing the on-disk format of `sessions.json` without a migration.

## If a release goes wrong

Delete the tag and release, fix, and re-tag:

```sh
gh release delete v0.2.0 --yes
git push --delete origin v0.2.0
```

## Adding PyPI later

If TermDeck is later published to PyPI, re-add a `publish-pypi` job to `release.yml` (create a `release`
environment and a `PYPI_API_TOKEN` secret), point the Homebrew formula's `url` at the PyPI sdist, and switch
the install docs to `pip install termdeck`.
