# launchd

You almost certainly don't need anything in this directory.

`termdeck service install` generates a correct launchd agent at
`~/Library/LaunchAgents/com.termdeck.plist`, pointing at whichever interpreter or console script you
installed with, and carrying your current `TERMDECK_*` settings. Use that:

```sh
termdeck service install
termdeck service restart
termdeck service logs
termdeck service uninstall
```

`com.termdeck.dev.plist` is the maintainer's development unit — it runs `run.sh` from a source checkout
instead of an installed package, with absolute paths baked in. It is kept for reference only. To adapt it,
replace every path with your own and copy it to `~/Library/LaunchAgents/`.
