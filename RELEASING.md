# Releasing

The steps to cut a TermDeck release. Only the maintainer needs this.

TermDeck's Python distribution is `termdeck-agents`; its command and Homebrew formula remain `termdeck`.
GitHub artifacts use the normalized prefix `termdeck_agents` starting with 0.12.2.

- **Homebrew** (macOS): the [`danialfarid/homebrew-tap`](https://github.com/danialfarid/homebrew-tap) formula.
- **uv / pipx** (everywhere): `termdeck-agents` from PyPI, with GitHub reference installs available for development.

## One-time setup

The Homebrew tap repository:

```sh
gh repo create danialfarid/homebrew-tap --public --description "Homebrew tap for termdeck"
```

Homebrew does not require PyPI publication. Set up trusted publishing below to enable PyPI releases.

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
/tmp/termdeck-verify/bin/pip install dist/*.whl
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

Only after the release source archive is uploaded — the formula hashes the uploaded `termdeck_agents-X.Y.Z.tar.gz`
asset. The asset URL lets GitHub report aggregate download events without application telemetry.

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

## PyPI trusted publishing

Register a pending publisher at https://pypi.org/manage/account/publishing/ with:

- Project: `termdeck-agents`
- Owner/repository: `danialfarid` / `termdeck`
- Workflow: `publish-pypi.yml`
- Environment: `pypi`

Create the `pypi` GitHub environment with release-only protections and set the repository variable
`PYPI_PUBLISH_ENABLED=true` after registration. Tagged releases then publish the same tested wheel and
source archive uploaded to GitHub using short-lived OIDC credentials, without a stored PyPI token.
To publish an existing release, run `gh workflow run publish-pypi.yml --ref vX.Y.Z -f release_tag=vX.Y.Z`.
Never publish under `termdeck`: that name belongs to another project.

The first PyPI release is 0.12.3; the recommended Python install is `uv tool install termdeck-agents`. Homebrew continues using
GitHub release assets and its existing install command. PyPI download events and GitHub asset counts are
aggregate distribution statistics, not unique installations or active-user telemetry.
