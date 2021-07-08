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

import logging
import sys

from tornado.ioloop import IOLoop
from tornado.iostream import PipeIOStream

from inmantals.server import InmantaLSHandler

logger = logging.getLogger(__name__)


def main():
    stdin = PipeIOStream(sys.stdin.fileno())
    stdout = PipeIOStream(sys.stdout.fileno())
    handler = InmantaLSHandler(stdin, stdout, "0.0.0.0")

    logger.info("Starting language server")

    try:
        IOLoop.current().run_sync(handler.start)
    except Exception as e:
        logging.error(e)

    logger.info("Language server stopped")


if __name__ == "__main__":
    main()
