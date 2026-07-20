from setproctitle import setproctitle

setproctitle("termdeck")

from termdeck.server import TermdeckServer

TermdeckServer().run()
