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

from tornado.ioloop import IOLoop
from inmantals.server import InmantaLSHandler
import logging
from tornado.iostream import PipeIOStream
import sys


def main():
    stream = logging.FileHandler("/tmp/vscode-inmanta.log")
    stream.setLevel(logging.DEBUG)
    stream2 = logging.StreamHandler(sys.stderr)
    stream2.setLevel(logging.INFO)
    logging.root.handlers = []
    logging.root.addHandler(stream)
    logging.root.addHandler(stream2)
    logging.root.setLevel(0)

    logging.basicConfig(level=logging.DEBUG)

    stdin = PipeIOStream(sys.stdin.fileno())
    stdout = PipeIOStream(sys.stdout.fileno())
    handler = InmantaLSHandler(stdin, stdout, "0.0.0.0")
    sys.stderr.write("starting")
    sys.stderr.flush()

    IOLoop.current().run_sync(handler.start)

    sys.stderr.write("stopped")
    sys.stderr.flush()


if __name__ == "__main__":
    main()
