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

import json
import logging
from inmantals.jsonrpc import JsonRpcHandler, MethodNotFoundException, InvalidParamsException
from tornado import gen
import os
from inmanta import compiler
from inmanta.util import groupby
from intervaltree.intervaltree import IntervalTree
from inmanta.ast import Range
from concurrent.futures.thread import ThreadPoolExecutor
from tornado.iostream import BaseIOStream
from inmanta import resources, export
from inmanta.agent import handler
from inmanta.module import Project

logger = logging.getLogger(__name__)


class InmantaLSHandler(JsonRpcHandler):

    def __init__(self, instream: BaseIOStream, outstream: BaseIOStream, address):
        super(InmantaLSHandler, self).__init__(instream, outstream, address)
        self.threadpool = ThreadPoolExecutor(1)
        self.anchormap = None

    @gen.coroutine
    def initialize(self, rootPath, rootUri, **kwargs):
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
                    "save": {
                        "includeText": False
                    }
                },
                "definitionProvider": True
            }
        }

    def flatten(self, line, char):
        """ convert linenr char combination into a single number"""
        assert char < 100000
        return line * 100000 + char

    def compile_and_anchor(self):
        try:
            #reset all
            resources.resource.reset()
            export.Exporter.reset()
            handler.Commander.reset()

            #fresh project
            Project.set(Project(self.rootPath))

            anchormap = compiler.anchormap()

            def treeify(iterator):
                tree = IntervalTree()
                for f, t in iterator:
                    start = self.flatten(f.lnr - 1, f.start_char - 1)
                    end = self.flatten(f.end_lnr - 1, f.end_char - 1)
                    tree[start:end] = t
                return tree

            self.anchormap = {os.path.realpath(k): treeify(v) for k, v in groupby(anchormap, lambda x: x[0].file)}
        except Exception:
            logger.exception("Compile failed")

    @gen.coroutine
    def initialized(self):
        yield self.threadpool.submit(self.compile_and_anchor)

    @gen.coroutine
    def shutdown(self, **kwargs):
        pass

    @gen.coroutine
    def exit(self, **kwargs):
        self.running = False

    @gen.coroutine
    def textDocument_didOpen(self, **kwargs):
        pass

    @gen.coroutine
    def textDocument_didChange(self, **kwargs):
        pass

    @gen.coroutine
    def textDocument_didSave(self, **kwargs):
        yield self.threadpool.submit(self.compile_and_anchor)

    @gen.coroutine
    def textDocument_didClose(self, **kwargs):
        pass

    def convertLocation(self, loc):
        if isinstance(loc, Range):
            return {
                "uri": 'file://' + loc.file,
                "range": {
                    "start": {"line": loc.lnr - 1, "character": loc.start_char - 1},
                    "end": {"line": loc.end_lnr - 1, "character": loc.end_char - 1}
                }
            }
        else:
            return {
                "uri": 'file://' + loc.file,
                "range": {
                    "start": {"line": loc.lnr - 1, "character": 0}}
            }

    @gen.coroutine
    def textDocument_definition(self, textDocument, position):
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
        return self.convertLocation(loc)

    # Protocol handling

    def mangle(self, name):
        return name.replace("/", "_")

    @gen.coroutine
    def dispatch_method(self, id, method, params):
        pymethod = self.mangle(method)

        pym = getattr(self, pymethod, None)

        if pym is None:
            logger.debug("Call to unexisting method %s params %s", method, params)
            raise MethodNotFoundException("Could not find method %s" % method, id)

        if params is None:
            params = {}

        logger.debug("Called: %s %s", pymethod, params)

        try:
            result = yield pym(**params)
        except TypeError as e:
            raise InvalidParamsException(str(e), id)

        return result

    @gen.coroutine
    def send_show_message(self, type, message):
        yield self.send_notification("window/showMessage", {"type": type, "message": message})
