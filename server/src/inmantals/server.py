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
import os
import tempfile
import textwrap
import typing
from concurrent.futures.thread import ThreadPoolExecutor
from itertools import chain
from typing import Dict, Iterator, List, Optional, Set, Tuple

from tornado.iostream import BaseIOStream

import inmanta.ast.type as inmanta_type
import pkg_resources
import yaml
from inmanta import compiler, module, resources
from inmanta.agent import handler
from inmanta.ast import CompilerException,Range, Location
from inmanta.ast.entity import Entity, Implementation
from inmanta.execute import scheduler
from inmanta.plugins import Plugin
from inmanta.util import groupby
from inmantals import lsp_types
from inmantals.jsonrpc import InvalidParamsException, JsonRpcHandler, MethodNotFoundException
from intervaltree.intervaltree import IntervalTree
from packaging import version

CORE_VERSION: version.Version = version.Version(pkg_resources.get_distribution("inmanta-core").version)
"""
Version of the inmanta-core package.
"""

LEGACY_MODE_COMPILER_VENV: bool = CORE_VERSION < version.Version("6.dev")
"""
Older versions of inmanta-core work with a separate compiler venv and install modules and their dependencies on the fly.
Recent versions use the encapsulating environment and require explicit project installation as a safeguard.
"""

BEFORE_ANCHOR_TARGET: bool = CORE_VERSION <= version.Version("8.3.dev")
"""
Older versions of inmanta-core work with a separate compiler venv and install modules and their dependencies on the fly.
Recent versions use the encapsulating environment and require explicit project installation as a safeguard.
"""

if not BEFORE_ANCHOR_TARGET:
    from inmanta.ast import AnchorTarget
else :
    class AnchorTarget(object):
        def __init__(
            self,
            location: Location,
            docstring: Optional[str] = None,
        ) -> None:
            """
            :param location: the location of the target of the anchor
            :param docstring: the docstring attached to the target
            """
            self.location = location
            self.docstring = docstring

logger = logging.getLogger(__name__)

class InvalidExtensionSetup(Exception):
    """The extension can only run on a valid project or module, and not on a single file."""

    def __init__(self, message: str) -> None:
        Exception.__init__(self, message)
        self.message = message


class InmantaLSHandler(JsonRpcHandler):
    def __init__(self, instream: BaseIOStream, outstream: BaseIOStream, address):
        super(InmantaLSHandler, self).__init__(instream, outstream, address)
        self.threadpool = ThreadPoolExecutor(1)
        self.anchormap = None
        self.reverse_anchormap = None
        self.types: Optional[Dict[str, inmanta_type.Type]] = None
        self.state_lock: asyncio.Lock = asyncio.Lock()
        self.diagnostics_cache: Optional[lsp_types.PublishDiagnosticsParams] = None
        self.supported_symbol_kinds: Optional[Set[lsp_types.SymbolKind]] = None
        # compiler_venv_path is only relevant for versions of core that require a compiler venv. It is ignored otherwise.
        self.compiler_venv_path: Optional[str] = None

    async def initialize(self, rootPath, rootUri, capabilities: Dict[str, object], **kwargs):  # noqa: N803
        logger.debug("Init: " + json.dumps(kwargs))

        if rootPath is None:
            raise InvalidExtensionSetup("A folder should be opened instead of a file in order to use the inmanta extension.")

        self.rootPath = rootPath
        self.rootUrl = rootUri
        os.chdir(rootPath)
        init_options = kwargs.get("initializationOptions", None)

        if init_options:
            self.compiler_venv_path = init_options.get("compilerVenv", os.path.join(self.rootPath, ".env-ls-compiler"))
            self.repos = init_options.get("repos", None)

        value_set: List[int]
        try:
            value_set: List[int] = capabilities["workspace"]["symbol"]["symbolKind"]["valueSet"]  # type: ignore
        except KeyError:
            value_set = []

        def to_symbol_kind(value: int) -> Optional[lsp_types.SymbolKind]:
            try:
                return lsp_types.SymbolKind(value)
            except ValueError:
                logging.warning("Client specified unsupported symbol kind %s" % value)
                return None

        self.supported_symbol_kinds = {symbol for symbol in map(to_symbol_kind, value_set) if symbol is not None}

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
                "workspaceSymbolProvider": {
                    # the language server does not report work done progress for workspace symbol requests
                    "workDoneProgress": False,
                },
                "hoverProvider": True,
            }
        }

    def flatten(self, line, char):
        """convert linenr char combination into a single number"""
        assert char < 100000
        return line * 100000 + char

    def create_tmp_project(self) -> str:
        self.project_dir = tempfile.TemporaryDirectory()
        logger.info(f"Temporary project created at {self.project_dir.name}.")

        os.mkdir(os.path.join(self.project_dir.name, "libs"))

        install_mode = module.InstallMode.master

        modulepath = ["libs", os.path.dirname(self.rootPath)]

        with open(os.path.join(self.project_dir.name, "project.yml"), "w+") as fd:
            metadata: typing.Mapping[str, object] = {
                "name": "Temporary project",
                "description": "Temporary project",
                "repo": yaml.safe_load(self.repos),
                "modulepath": modulepath,
                "downloadpath": "libs",
                "install_mode": install_mode.value,
            }
            yaml.dump(metadata, fd)

        v2_metadata_file: str = os.path.join(self.rootPath, module.ModuleV2.MODULE_FILE)
        v1_metadata_file: str = os.path.join(self.rootPath, module.ModuleV1.MODULE_FILE)

        module_name: Optional[str] = None
        if os.path.exists(v2_metadata_file):
            mv2 = module.ModuleV2(project=None, path=self.rootPath)
            module_name = mv2.name
        elif os.path.exists(v1_metadata_file):
            mv1 = module.ModuleV1(project=None, path=self.rootPath)
            module_name = mv1.name

        if not module_name:
            error_message: str = (
                "The Inmanta extension only works on projects and modules. "
                "Please make sure the current workspace is a valid project "
                "(https://docs.inmanta.com/inmanta-service-orchestrator/latest/model_developers/project_creation.html) or "
                "module (https://docs.inmanta.com/inmanta-service-orchestrator/latest/model_developers/module_creation.html)."
            )
            raise InvalidExtensionSetup(error_message)

        with open(os.path.join(self.project_dir.name, "main.cf"), "w+") as fd:
            fd.write(f"import {module_name}\n")

        return self.project_dir.name

    async def compile_and_anchor(self) -> None:
        def sync_compile_and_anchor() -> None:
            def setup_project():
                # Check that we are working inside an existing project:
                project_file: str = os.path.join(self.rootPath, module.Project.PROJECT_FILE)
                if os.path.exists(project_file):
                    project_dir: str = self.rootPath

                else:
                    # Create a project in the vscode temp folder
                    project_dir = self.create_tmp_project()

                if LEGACY_MODE_COMPILER_VENV:
                    if self.compiler_venv_path:
                        logger.debug("Using venv path " + str(self.compiler_venv_path))
                        module.Project.set(module.Project(project_dir, venv_path=self.compiler_venv_path))
                    else:
                        module.Project.set(module.Project(project_dir))
                else:
                    module.Project.set(module.Project(project_dir))
                    module.Project.get().install_modules()

            # reset all
            resources.resource.reset()
            handler.Commander.reset()

            # fresh project
            setup_project()

            # can't call compiler.anchormap and compiler.get_types_and_scopes directly because of inmanta/inmanta#2471
            compiler_instance: compiler.Compiler = compiler.Compiler()
            (statements, blocks) = compiler_instance.compile()
            scheduler_instance = scheduler.Scheduler()
            anchormap = scheduler_instance.anchormap(compiler_instance, statements, blocks)
            anchermap_with_anchorTarget = [(s, AnchorTarget(t)) if isinstance(t, Range) or isinstance(t, Location) else (s,t)  for s, t in anchormap]
            self.types = scheduler_instance.get_types()

            def treeify(iterator):
                tree = IntervalTree()
                for f, t in iterator:
                    start = self.flatten(f.lnr - 1, f.start_char - 1)
                    end = self.flatten(f.end_lnr - 1, f.end_char - 1)
                    tree[start:end] = t
                return tree

            self.anchormap = {os.path.realpath(k): treeify(v) for k, v in groupby(anchermap_with_anchorTarget, lambda x: x[0].file)}
            def treeify_reverse(iterator):
                tree = IntervalTree()
                for f, t in iterator:
                    if isinstance(t, AnchorTarget) and isinstance(t.location, Range):
                        start = self.flatten(t.location.lnr - 1, t.location.start_char - 1)
                        end = self.flatten(t.location.end_lnr - 1, t.location.end_char - 1)
                        if start <= end:
                            tree[start:end] = f
                return tree

            self.reverse_anchormap = {
                os.path.realpath(k): treeify_reverse(v) for k, v in groupby(anchermap_with_anchorTarget, lambda x: x[1].location.file)
            }

        try:
            if self.shutdown_requested:
                return
            # run synchronous part in executor to allow context switching while awaiting
            await asyncio.get_event_loop().run_in_executor(self.threadpool, sync_compile_and_anchor)
            await self.publish_diagnostics(None)
            logger.info("Compilation succeeded")
        except asyncio.CancelledError:
            # Language server is shutting down. Tasks in threadpool were cancelled.
            pass
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
            await self.handle_module_loading_exception(e)
            logger.exception("Compilation failed")
        except InvalidExtensionSetup as e:
            await self.handle_invalid_extension_setup(e)
            logger.error(e)

        except Exception:
            await self.publish_diagnostics(None)
            logger.exception("Compilation failed")

    async def handle_invalid_extension_setup(self, e: InvalidExtensionSetup):
        await self.send_show_message(
            lsp_types.MessageType.Warning,
            f"{e.message}.",
        )

    async def handle_module_loading_exception(self, e: CompilerException):
        """
        Send a suggestion to the user to run the inmanta project install command when a module install failure is detected.
        """
        if CORE_VERSION < version.Version("5"):
            # ModuleLoadingException doesn't exist in iso4, use ModuleNotFoundException instead.
            module_loading_exception = module.ModuleNotFoundException
        else:
            module_loading_exception = module.ModuleLoadingException

        if isinstance(e, module_loading_exception):
            await self.send_show_message(
                lsp_types.MessageType.Warning,
                f"{e.format()}. Try running `inmanta project install` to install missing modules.",
            )

    async def initialized(self):
        await self.compile_and_anchor()

    async def shutdown(self, **kwargs):
        self.shutdown_requested = True
        self.cleanup_tmp()
        self.threadpool.shutdown(cancel_futures=True)

    def cleanup_tmp(self):
        self.project_dir.cleanup()

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

    def convert_location(self, target):
        prefix = "file:///" if os.name == "nt" else "file://"
        if isinstance(target, AnchorTarget) and isinstance(target.location, Range):
            return {
                "uri": prefix + target.location.file,
                "range": {
                    "start": {"line": target.location.lnr - 1, "character": target.location.start_char - 1},
                    "end": {"line": target.location.end_lnr - 1, "character": target.location.end_char - 1},
                },
            }
        else:
            return {
                "uri": prefix + target.location.file,
                "range": {
                    "start": {"line": target.location.lnr - 1, "character": 0},
                    "end": {"line": target.location.lnr, "character": 0},
                },
            }

    def get_definition(self, target: AnchorTarget) -> str:
        file_path = target.location.file
        start_line = target.location.lnr - 1
        with open(file_path, "r") as f:
            line = f.readlines()[start_line]
        return line

    def get_file_type(self, filepath: str) -> str:
        file_extension = os.path.splitext(filepath)[1].lower()
        if file_extension == ".py":
            return "python"
        elif file_extension == ".cf":
            return "inmanta"
        else:
            return ""

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

    async def textDocument_references(self, textDocument, position, context):  # noqa: N802, N803  # noqa: N802, N803
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

    async def textDocument_hover(self, textDocument, position):
        logger.warn(position)
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

        data = list(range)[0].data
        docstring = textwrap.dedent(data.docstring.strip("\n")) if data.docstring else ""
        docstring = docstring.replace(" ", "&nbsp;")
        definition = self.get_definition(data).strip()
        language = self.get_file_type(data.location.file)
        definition_md = f"""
        ```{language}
        {definition}
        ```
        """
        value = textwrap.dedent(definition_md) + "\n___\n" + docstring
        return {
            "contents": {
                "kind": "markdown",
                "value": value,
            },
        }

    async def workspace_symbol(self, query: str) -> List[Dict[str, object]]:
        if self.types is None:
            return []

        query_upper: str = query.upper()
        matching_types: List[Tuple[str, inmanta_type.NamedType]] = [
            (name, tp)
            for name, tp in self.types.items()
            if isinstance(tp, inmanta_type.NamedType) and query_upper in name.upper()
        ]

        def get_symbol_kind(tp: inmanta_type.NamedType) -> lsp_types.SymbolKind:
            def if_supported(then: lsp_types.SymbolKind, otherwise: lsp_types.SymbolKind) -> lsp_types.SymbolKind:
                """
                Returns `then` iff the client can handle it, otherwise returns `otherwise`.
                If the client explicitly specifies its supported symbol kinds, it is expected to gracefully handle symbol kinds
                outside of this set. If it doesn't specify its supported symbol kinds, it must support all symbol kinds up to
                Array.
                """
                return then if (self.supported_symbol_kinds is not None and then in self.supported_symbol_kinds) else otherwise

            if isinstance(tp, Plugin):
                return lsp_types.SymbolKind.Function
            if isinstance(tp, inmanta_type.ConstraintType):
                return lsp_types.SymbolKind.Class
            if isinstance(tp, Entity):
                return lsp_types.SymbolKind.Class
            if isinstance(tp, Implementation):
                return lsp_types.SymbolKind.Constructor

            logger.warning("Unknown type %s, using default symbol kind" % tp)
            return if_supported(lsp_types.SymbolKind.Object, lsp_types.SymbolKind.Variable)

        type_symbols: Iterator[lsp_types.SymbolInformation] = (
            lsp_types.SymbolInformation(
                name=name,
                kind=get_symbol_kind(tp),
                location=self.convert_location(tp.location),
            )
            for name, tp in matching_types
        )

        attribute_symbols: Iterator[lsp_types.SymbolInformation] = (
            lsp_types.SymbolInformation(
                name=attribute_name,
                kind=lsp_types.SymbolKind.Field,
                location=self.convert_location(attribute.location),
                container_name=entity_name,
            )
            for entity_name, entity in matching_types
            if isinstance(entity, Entity)
            for attribute_name, attribute in entity.attributes.items()
        )

        return [symbol.dict() for symbol in chain(type_symbols, attribute_symbols)]

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

    async def send_show_message(self, type: lsp_types.MessageType, message: str):
        """
        Show a pop up message to the user, type gives the level of the message, message is the content
        """
        await self.send_notification("window/showMessage", {"type": type.value, "message": message})

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
            await self.send_notification("textDocument/publishDiagnostics", publish_params.dict())
            self.diagnostics_cache = params
