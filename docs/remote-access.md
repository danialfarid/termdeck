# Remote access

TermDeck Remote keeps the terminal server bound to localhost. The local TermDeck process authenticates with a
hosted relay and opens an outbound tunnel only when an authenticated browser requests it. No inbound port,
router rule, public IP, or local TLS certificate is required.

## Local Wi-Fi access

For direct access from a phone or another computer on the same network, open Settings and enable **Local Wi-Fi**.
TermDeck starts a separate listener on port `8532` and shows the local URL to open. This connection stays on the
local network and does not use Google sign-in, the hosted relay, or the internet.

The listener accepts only loopback clients and clients inside a private subnet currently assigned to the computer.
It is plain HTTP with no user authentication, so anyone on that local network can control terminals and access the
files exposed by TermDeck. Enable it only on a trusted home or office network and disable it on public Wi-Fi. The
port can be changed with `TERMDECK_LAN_PORT` or `termdeck --lan-port`.

## Connect a computer

Set the relay URL before installing or restarting the TermDeck background service:

```sh
export TERMDECK_REMOTE_URL=https://your-relay.example.com
termdeck service install
```

Open TermDeck, select Settings, then select **Sign in** beside **Remote access**. Complete Google sign-in in the
new browser tab. The local credential is stored in `~/.termdeck/remote-credentials.json` with owner-only file
permissions. TermDeck stores no Google access or refresh token locally.

Once paired, sign into the relay from a phone or another browser with the same Google account. The relay matches
the browser and computer using Google's stable account subject. A new computer pairing replaces the previous
connector for that account.

The local connector polls for demand while idle. It opens its multiplexed WebSocket when a remote browser arrives
and the relay closes it after the last browser channel disappears. This permits request-billed hosting platforms
to scale down while remote access is unused.

The hosted browser pauses after ten minutes without keyboard, pointer, touch, or scroll interaction. It switches to
an authenticated idle page with no polling or WebSockets, then reconnects through a fresh TermDeck page load on the
next interaction. Terminals continue running locally while the remote browser is paused. Set
`TERMDECK_REMOTE_BROWSER_IDLE_SECONDS` on the relay to change the timeout or set it to `0` to disable browser idling.

## Security model

- The relay validates Google ID token signature, issuer, audience, expiry, verified email, and stable subject.
- Browser sessions and connector credentials use separate signed token domains and expiration periods.
- Firestore stores only the Google subject, display email, and SHA-256 connector-token digest.
- Pairing secrets are random, short-lived, rate-limited, and stored only as digests by the relay.
- Browser mutations and WebSocket handshakes require the configured HTTPS origin.
- The remote connector strips hosted cookies and WebSocket negotiation headers before forwarding locally.
- Pairing another computer rotates the account's connector credential and disconnects the prior computer.
- The hosted relay can observe proxied terminal traffic. This first version is encrypted in transit but is not
  end-to-end encrypted from the browser to the local computer.

## Limits

The initial Cloud Run deployment must use one maximum instance because browser and connector WebSockets are
paired in memory. Clients reconnect when Cloud Run reaches its WebSocket request timeout. A multi-instance version
requires a shared connection router rather than relying on session affinity.

Remote HTTP request bodies are capped below Cloud Run's HTTP/1 request limit. Large local uploads should be made
from the computer until chunked remote uploads are implemented.

## Self-hosting the relay

The relay source is in `remote_service/`. It requires:

- `TERMDECK_REMOTE_GOOGLE_CLIENT_ID`
- `TERMDECK_REMOTE_SESSION_SECRET`
- `TERMDECK_REMOTE_PUBLIC_URL`
- `GOOGLE_CLOUD_PROJECT` for Firestore persistence

For local development without a Google Cloud project, omitting `GOOGLE_CLOUD_PROJECT` uses an in-memory connector
token store. That mode loses pairings on restart and is not suitable for a public deployment.
