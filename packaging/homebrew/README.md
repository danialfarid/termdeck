# Homebrew packaging

TermDeck is distributed through a personal tap, `danialfarid/homebrew-tap`, so users install it with:

```sh
brew install danialfarid/tap/termdeck
```

The tap is a separate GitHub repository whose only job is to hold `Formula/termdeck.rb`. The formula itself
is generated from this directory.

## Why a tap and not homebrew-core

homebrew-core requires a package to be notable (roughly: meaningful stars, age, and third-party packaging)
before it will accept a formula. A personal tap has no such gate and behaves identically for users apart from
the one-time longer install name. Moving to homebrew-core later is just a formula submission — nothing about
the package has to change.

## Generating the formula

Homebrew builds Python applications from source, which means the formula has to pin **every transitive
dependency** as a `resource` with an sdist URL and sha256. `generate_formula.py` does that by resolving the
real dependency set in a throwaway virtualenv and then looking each package up on PyPI.

Run it **after** the version is live on PyPI, because it downloads the released sdist to hash it:

```sh
python packaging/homebrew/generate_formula.py           # version from termdeck/__init__.py
python packaging/homebrew/generate_formula.py 0.2.0     # or an explicit version
```

It writes `packaging/homebrew/termdeck.rb`.

## Publishing to the tap

One-time setup:

```sh
gh repo create danialfarid/homebrew-tap --public --description "Homebrew tap for termdeck"
git clone https://github.com/danialfarid/homebrew-tap.git
mkdir -p homebrew-tap/Formula
```

Each release:

```sh
python packaging/homebrew/generate_formula.py
cp packaging/homebrew/termdeck.rb ../homebrew-tap/Formula/termdeck.rb
cd ../homebrew-tap
git add Formula/termdeck.rb && git commit -m "termdeck 0.1.0" && git push
```

## Testing the formula before pushing

```sh
brew install --build-from-source packaging/homebrew/termdeck.rb
brew test termdeck
brew audit --strict --new packaging/homebrew/termdeck.rb
termdeck doctor
```

`brew audit --new` applies the strictest rules (the ones homebrew-core would apply) and is worth passing even
for a tap.

## Notes on the formula

- `depends_on "dtach"` is what makes the Homebrew path nicer than pip: users get the one hard external
  dependency automatically. `ripgrep` comes along for search.
- The dependency closure is deliberately small — plain `uvicorn` plus `websockets` rather than
  `uvicorn[standard]` — which keeps `watchfiles` (and therefore a Rust toolchain) out of the build.
- The `service do` block lets users run `brew services start termdeck` as an alternative to
  `termdeck service install`. Both work; `termdeck service install` is the documented path because it is the
  same on every install method.
- Bump `PYTHON_FORMULA` in `generate_formula.py` when Homebrew's default Python moves.
