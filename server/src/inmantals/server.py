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
import asyncio
import json
import logging
from inmantals.jsonrpc import (
    JsonRpcHandler,
    MethodNotFoundException,
    InvalidParamsException,
)
import os
from inmanta import compiler
from inmanta.util import groupby
from intervaltree.intervaltree import IntervalTree
from inmanta.ast import Range
from concurrent.futures.thread import ThreadPoolExecutor
from tornado.iostream import BaseIOStream
from inmanta import resources
from inmanta.agent import handler
from inmanta.module import Project

logger = logging.getLogger(__name__)


class InmantaLSHandler(JsonRpcHandler):
    def __init__(self, instream: BaseIOStream, outstream: BaseIOStream, address):
        super(InmantaLSHandler, self).__init__(instream, outstream, address)
        self.threadpool = ThreadPoolExecutor(1)
        self.anchormap = None

    async def initialize(self, rootPath, rootUri, **kwargs):  # noqa: N803
        logger.debug("Init: " + json.dumps(kwargs))

        self.rootPath = rootPath
        self.rootUrl = rootUri
        os.chdir(rootPath)

        return {
            "capabilities": {
                "textDocumentSync": {
                    "openClose": True,
                    "change": 1,  # Full 1
                    "willSave": False,
                    "willSaveWaitUntil": False,
                    "save": {"includeText": False},
                },
                "definitionProvider": True,
            }
        }

    def flatten(self, line, char):
        """ convert linenr char combination into a single number"""
        assert char < 100000
        return line * 100000 + char

    def compile_and_anchor(self):
        try:
            # reset all
            resources.resource.reset()
            handler.Commander.reset()

            # fresh project
            Project.set(Project(self.rootPath))

            anchormap = compiler.anchormap()

            def treeify(iterator):
                tree = IntervalTree()
                for f, t in iterator:
                    start = self.flatten(f.lnr - 1, f.start_char - 1)
                    end = self.flatten(f.end_lnr - 1, f.end_char - 1)
                    tree[start:end] = t
                return tree

            self.anchormap = {
                os.path.realpath(k): treeify(v)
                for k, v in groupby(anchormap, lambda x: x[0].file)
            }
        except Exception:
            logger.exception("Compile failed")

    async def initialized(self):
        await asyncio.get_event_loop().run_in_executor(self.threadpool, self.compile_and_anchor)

    async def shutdown(self, **kwargs):
        pass

    async def exit(self, **kwargs):
        self.running = False

    async def textDocument_didOpen(self, **kwargs):  # noqa: N802
        pass

    async def textDocument_didChange(self, **kwargs):  # noqa: N802
        pass

    async def textDocument_didSave(self, **kwargs):  # noqa: N802
        await asyncio.get_event_loop().run_in_executor(self.threadpool, self.compile_and_anchor)

    async def textDocument_didClose(self, **kwargs):  # noqa: N802
        pass

    def convert_location(self, loc):
        if isinstance(loc, Range):
            return {
                "uri": "file://" + loc.file,
                "range": {
                    "start": {"line": loc.lnr - 1, "character": loc.start_char - 1},
                    "end": {"line": loc.end_lnr - 1, "character": loc.end_char - 1},
                },
            }
        else:
            return {
                "uri": "file://" + loc.file,
                "range": {"start": {"line": loc.lnr - 1, "character": 0}},
            }

    async def textDocument_definition(self, textDocument, position):  # noqa: N802, N803
        uri = textDocument["uri"]

        url = os.path.realpath(uri.replace("file://", ""))

        if self.anchormap is None:
            return {}

        if url not in self.anchormap:
            return {}

        tree = self.anchormap[url]

        range = tree[self.flatten(position["line"], position["character"])]

        if range is None or len(range) == 0:
            return {}
        loc = list(range)[0].data
        return self.convert_location(loc)

    # Protocol handling

    def mangle(self, name):
        return name.replace("/", "_")

    async def dispatch_method(self, id, method, params):
        pymethod = self.mangle(method)

        pym = getattr(self, pymethod, None)

        if pym is None:
            logger.debug("Call to unexisting method %s params %s", method, params)
            raise MethodNotFoundException("Could not find method %s" % method, id)

        if params is None:
            params = {}

        logger.debug("Called: %s %s", pymethod, params)

        try:
            result = await pym(**params)
        except TypeError as e:
            raise InvalidParamsException(str(e), id)

        return result

    async def send_show_message(self, type, message):
        await self.send_notification(
            "window/showMessage", {"type": type, "message": message}
        )
