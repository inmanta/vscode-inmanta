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

import os
import sys

from tornado.ioloop import IOLoop

from inmantals.jsonrpc import JsonRpcServer
from inmantals.server import InmantaLSHandler


def main():
    server = JsonRpcServer(InmantaLSHandler)

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5432
    sys.stdout.write(f"Starting server on port {port}{os.linesep}")
    sys.stdout.write(f"Log file can be found at {server.logfile}{os.linesep}")
    sys.stdout.flush()
    server.listen(port, address="127.0.0.1")
    IOLoop.current().start()


if __name__ == "__main__":
    main()
