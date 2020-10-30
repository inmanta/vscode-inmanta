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
import inspect
import json
import logging
from inmantals import lsp_types
from inmantals.jsonrpc import (
    JsonRpcHandler,
    MethodNotFoundException,
    InvalidParamsException,
)
import os
import types
from typing import Dict, Optional
from inmanta import compiler
from inmanta.util import groupby
from intervaltree.intervaltree import IntervalTree
from inmanta.ast import CompilerException, Range
from concurrent.futures.thread import ThreadPoolExecutor
from tornado.iostream import BaseIOStream
from inmanta import resources
from inmanta.agent import handler
from inmanta.module import Project

# This module has only been added in inmanta v2020.3.
ast_export: Optional[types.ModuleType]
try:
    import inmanta.ast.export  # type: ignore
    ast_export = inmanta.ast.export
except ModuleNotFoundError:
    ast_export = None

logger = logging.getLogger(__name__)


class InmantaLSHandler(JsonRpcHandler):
    def __init__(self, instream: BaseIOStream, outstream: BaseIOStream, address):
        super(InmantaLSHandler, self).__init__(instream, outstream, address)
        self.threadpool = ThreadPoolExecutor(1)
        self.anchormap = None
        self.reverse_anchormap = None
        self.state_lock: asyncio.Lock = asyncio.Lock()
        self.diagnostics_cache: Optional[lsp_types.PublishDiagnosticsParams] = None
        self.compiler_venv_path: Optional[str] = None

    async def initialize(self, rootPath, rootUri, **kwargs):  # noqa: N803
        logger.debug("Init: " + json.dumps(kwargs))

        self.rootPath = rootPath
        self.rootUrl = rootUri
        os.chdir(rootPath)
        init_options = kwargs.get("initializationOptions", None)
        if init_options:
            self.compiler_venv_path = init_options.get("compilerVenv", os.path.join(self.rootPath, ".env-ls-compiler"))

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
                "referencesProvider": True,
            }
        }

    def flatten(self, line, char):
        """ convert linenr char combination into a single number"""
        assert char < 100000
        return line * 100000 + char

    async def compile_and_anchor(self) -> None:
        def sync_compile_and_anchor() -> None:
            # reset all
            resources.resource.reset()
            handler.Commander.reset()

            project_signature = inspect.signature(Project.__init__)
            # fresh project
            if "venv_path" in project_signature.parameters.keys() and self.compiler_venv_path:
                logger.debug("Using venv path " + str(self.compiler_venv_path))
                Project.set(Project(self.rootPath, venv_path=self.compiler_venv_path))
            else:
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

            def treeify_reverse(iterator):
                tree = IntervalTree()
                for f, t in iterator:
                    if isinstance(t, Range):
                        start = self.flatten(t.lnr - 1, t.start_char - 1)
                        end = self.flatten(t.end_lnr - 1, t.end_char - 1)
                        if start <= end:
                            tree[start:end] = f
                return tree

            self.reverse_anchormap = {
                os.path.realpath(k): treeify_reverse(v)
                for k, v in groupby(anchormap, lambda x: x[1].file)
            }

        try:
            # run synchronous part in executor to allow context switching while awaiting
            await asyncio.get_event_loop().run_in_executor(self.threadpool, sync_compile_and_anchor)
            await self.publish_diagnostics(None)

        except CompilerException as e:
            params: Optional[lsp_types.PublishDiagnosticsParams]
            if e.location is None:
                params = None
            else:
                location: Dict[str, object] = self.convert_location(e.location)
                params = lsp_types.PublishDiagnosticsParams(
                    uri=location["uri"],
                    diagnostics=[
                        lsp_types.Diagnostic(
                            range=location["range"],
                            severity=lsp_types.DiagnosticSeverity.Error,
                            message=e.get_message(),
                        )
                    ],
                )
            await self.publish_diagnostics(params)
            logger.exception("Compile failed")

        except Exception:
            await self.publish_diagnostics(None)
            logger.exception("Compile failed")

    async def initialized(self):
        await self.compile_and_anchor()

    async def shutdown(self, **kwargs):
        pass

    async def exit(self, **kwargs):
        self.running = False

    async def textDocument_didOpen(self, **kwargs):  # noqa: N802
        pass

    async def textDocument_didChange(self, **kwargs):  # noqa: N802
        pass

    async def textDocument_didSave(self, **kwargs):  # noqa: N802
        await self.compile_and_anchor()

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
                "range": {
                    "start": {"line": loc.lnr - 1, "character": 0},
                    "end": {"line": loc.lnr - 1, "character": 0},
                },
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

    async def textDocument_references(self, textDocument, position, context):  # noqa: N802, N803
        uri = textDocument["uri"]

        url = os.path.realpath(uri.replace("file://", ""))

        if self.reverse_anchormap is None:
            return {}

        if url not in self.reverse_anchormap:
            return {}

        tree = self.reverse_anchormap[url]

        range = tree[self.flatten(position["line"], position["character"])]

        if range is None or len(range) == 0:
            return {}

        return [self.convert_location(loc.data) for loc in range]

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

    async def publish_diagnostics(self, params: Optional[lsp_types.PublishDiagnosticsParams]) -> None:
        """
        Publishes supplied diagnostics and caches it. If params is None, clears previously published diagnostics.
        """
        async with self.state_lock:
            publish_params: lsp_types.PublishDiagnosticsParams
            if params is None:
                if self.diagnostics_cache is None:
                    return
                publish_params = lsp_types.PublishDiagnosticsParams(uri=self.diagnostics_cache.uri, diagnostics=[])
            else:
                publish_params = params
            await self.send_notification("textDocument/publishDiagnostics", publish_params.dict(exclude_none=True))
            self.diagnostics_cache = params
