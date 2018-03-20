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
import logging


def main():
    stream = logging.StreamHandler()
    stream.setLevel(logging.DEBUG)
    logging.root.handlers = []
    logging.root.addHandler(stream)
    logging.root.setLevel(0)

    logging.basicConfig(level=logging.DEBUG)
    server = JsonRpcServer(InmantaLSHandler)
    server.listen(5432)
    IOLoop.current().start()


if __name__ == "__main__":
    main()
