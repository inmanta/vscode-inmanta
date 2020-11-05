"""
    Copyright 2018 Inmanta

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

    Contact: code@inmanta.com
"""

from inmantals.jsonrpc import JsonRpcServer
from tornado.ioloop import IOLoop
from inmantals.server import InmantaLSHandler
import os
import tempfile
import logging
import sys


def main():
    logfile = os.path.join(str(tempfile.gettempdir()), "vscode-inmanta.log") if os.name == "nt" else "/tmp/vscode-inmanta.log"
    stream = logging.FileHandler(logfile)
    stream.setLevel(logging.DEBUG)
    stream2 = logging.StreamHandler(sys.stderr)
    stream2.setLevel(logging.INFO)
    logging.root.handlers = []
    logging.root.addHandler(stream)
    logging.root.addHandler(stream2)
    logging.root.setLevel(0)

    logging.basicConfig(level=logging.DEBUG)

    server = JsonRpcServer(InmantaLSHandler)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5432
    sys.stdout.write(f"starting server on port {port}{os.linesep}")
    sys.stdout.flush()
    sys.stdout.write(f"Log file can be found at {logfile}{os.linesep}")
    sys.stdout.flush()
    server.listen(port, address="127.0.0.1")
    IOLoop.current().start()


if __name__ == "__main__":
    main()
