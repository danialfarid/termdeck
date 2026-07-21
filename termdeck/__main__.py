from setproctitle import setproctitle

setproctitle("_termdeck")

from termdeck.server import TermdeckServer

TermdeckServer().run()
