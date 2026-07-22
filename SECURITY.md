# Security Policy

## Threat model

TermDeck is a **local, single-user tool that runs arbitrary commands as you**. That is its purpose, not a
flaw. The security boundary is the network interface it binds to.

By default it binds `127.0.0.1`, so only processes on your own machine can reach it. There is **no
authentication and no authorization** — anyone who can reach the port can:

- run any command as your user
- read, write, and delete any file under the file root (your home directory by default)
- read and drive your Claude Code and Codex sessions

Consequences:

- **Never bind `0.0.0.0`** on an untrusted network. If you need remote access, forward the port over SSH:
  ```sh
  ssh -N -L 8530:127.0.0.1:8530 you@your-machine
  ```
  or put an authenticating reverse proxy in front of it.
- On a shared machine, remember that any local user who can reach `127.0.0.1:8530` has your shell.
- Narrow the file root (`--file-root ~/projects`) if you want a smaller blast radius.

## What counts as a vulnerability

Things we want to hear about:

- Escaping the file-root confinement (path traversal, symlink tricks, encoding tricks)
- Reaching command execution from a request that shouldn't allow it
- Cross-site attacks: a malicious web page or DNS-rebinding host driving the local API
- Leaking session IDs, uploads, or file contents to an unauthorized origin
- Writes outside the data directory and the file root

Things that are **not** vulnerabilities, because they're the documented design:

- Running commands through the terminal API — that's the product
- No authentication on a loopback bind
- Exposure caused by binding `0.0.0.0` yourself

## Reporting

Please report privately rather than opening a public issue:

- **Preferred:** [GitHub private vulnerability reporting](https://github.com/danialfarid/termdeck/security/advisories/new)
- Otherwise, open a public issue containing only "security report, please provide a private contact" — with
  no details — and you'll get a channel to use.

Please include:

- Version (`termdeck --version`), OS
- A description of the issue and its impact
- Reproduction steps or a proof of concept
- Anything you think would mitigate it

Expect an acknowledgement within a few days. This is a solo, best-effort project — there is no SLA, but
reports are taken seriously and fixes are prioritized above features.

Please give a reasonable window to ship a fix before publishing details.

## Supported versions

Fixes land on the latest released version. There are no maintained backport branches.
