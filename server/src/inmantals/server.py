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
import typing
from concurrent.futures.thread import ThreadPoolExecutor
from itertools import chain
from typing import Dict, Iterator, List, Optional, Sequence, Set, Tuple, Union

from tornado.iostream import BaseIOStream

import inmanta.ast.type as inmanta_type
import pkg_resources
import yaml
from inmanta import compiler, module, resources
from inmanta.agent import handler
from inmanta.ast import CompilerException, Range
from inmanta.ast.entity import Entity, Implementation
from inmanta.execute import scheduler
from inmanta.plugins import Plugin
from inmanta.util import groupby
from inmantals import lsp_types
from inmantals.jsonrpc import InvalidParamsException, JsonRpcHandler, MethodNotFoundException
from intervaltree.intervaltree import IntervalTree
from packaging import version
from uri import URI

CORE_VERSION: version.Version = version.Version(pkg_resources.get_distribution("inmanta-core").version)
"""
Version of the inmanta-core package.
"""

LEGACY_MODE_COMPILER_VENV: bool = CORE_VERSION < version.Version("6.dev")
"""
Older versions of inmanta-core work with a separate compiler venv and install modules and their dependencies on the fly.
Recent versions use the encapsulating environment and require explicit project installation as a safeguard.
"""

logger = logging.getLogger(__name__)


class InvalidExtensionSetup(Exception):
    """The extension can only run on a valid project or module, and not on a single file."""

    def __init__(self, message: str) -> None:
        Exception.__init__(self, message)
        self.message = message


class Folder:
    """
    Wrapper class around a folder (inmanta module or inmanta project). This folder can either be standalone or live in a
    workspace alongside other folders.

    The constructor should not be called explicitly. Instantiation is done through the unpack_workspaces method
    :param folder_uri: uri of the folder that is assumed to live in a workspace
    :param name: name of the folder
    :param handler: reference to the InmantaLSHandler responsible for this folder
    """

    folder_uri: URI
    name: str
    inmanta_project_dir: Union[Optional[tempfile.TemporaryDirectory], str]
    handler: "InmantaLSHandler"

    def __init__(self, folder_uri: URI, name: str, handler: "InmantaLSHandler"):
        self.folder_uri = folder_uri
        self.name = name
        self.handler = handler  # Keep a reference to the handler for cleanup

        # Check that we are working inside an existing project:
        project_file: str = os.path.join(folder_uri.path, module.Project.PROJECT_FILE)
        if os.path.exists(project_file):
            self.inmanta_project_dir = os.path.dirname(project_file)
        else:
            self.inmanta_project_dir = None

    def get_project_dir(self) -> Optional[str]:
        """
        If this folder holds an inmanta project, this returns the path to this project.
        If this folder holds an inmanta module, this returns the path of the temporary
        inmanta project used to load this module (see BLABAL).
        """
        if not self.inmanta_project_dir:
            return None
        if isinstance(self.inmanta_project_dir, str):
            return self.inmanta_project_dir
        else:
            return self.inmanta_project_dir.name

    def get_setting(self, key: str, default: Optional[str] = None) -> Optional[str]:
        """
        Get an inmanta extension setting for this folder
        """
        if key == "compiler_venv_path":  # support for versions of core that require a compiler venv.
            return os.path.join(self.get_folder_path(), ".env-ls-compiler")
        try:
            # Look for some custom settings for this folder
            with open(os.path.join(self.get_folder_path(), ".vscode", "settings.json")) as settings_file:
                settings: dict[str, str] = json.load(settings_file)
                return settings.get(key, default)
        except FileNotFoundError:
            return default

    @classmethod
    def unpack_workspaces(cls, workspace_folders: Sequence[object], ls_handler: "InmantaLSHandler") -> Dict[str, "Folder"]:
        return {folder["uri"]: Folder(URI(folder["uri"]), folder["name"], ls_handler) for folder in workspace_folders}

    def cleanup(self) -> None:
        logger.info(f"calling cleanup for {self}")
        if self.inmanta_project_dir:
            self.handler.remove_folder(str(self.folder_uri))
            self.inmanta_project_dir.cleanup()

    def get_folder_path(self) -> str:
        """
        Convert the folders's uri into a regular path
        (https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#uri)
        """
        return self.folder_uri.path

    def create_tmp_project(self) -> str:
        self.inmanta_project_dir = tempfile.TemporaryDirectory()
        logger.debug(f"Temporary project created at {self.inmanta_project_dir.name}.")

        os.mkdir(os.path.join(self.inmanta_project_dir.name, "libs"))

        install_mode = module.InstallMode.master

        v2_metadata_file: str = os.path.join(self.get_folder_path(), module.ModuleV2.MODULE_FILE)
        v1_metadata_file: str = os.path.join(self.get_folder_path(), module.ModuleV1.MODULE_FILE)

        module_name: Optional[str] = None
        modulepath = ["libs"]
        if os.path.exists(v2_metadata_file):
            mv2 = module.ModuleV2(project=None, path=self.get_folder_path())
            module_name = mv2.name

        elif os.path.exists(v1_metadata_file):
            mv1 = module.ModuleV1(project=None, path=self.get_folder_path())
            module_name = mv1.name
            modulepath.append(os.path.dirname(self.get_folder_path()))

        if not module_name:
            error_message: str = (
                "The Inmanta extension only works on projects and modules. "
                f"Please make sure the folder opened at {self.get_folder_path()} is a valid "
                "[project](https://docs.inmanta.com/inmanta-service-orchestrator/latest/model_developers/project_creation.html)"
                " or "
                "[module](https://docs.inmanta.com/inmanta-service-orchestrator/latest/model_developers/module_creation.html)"
            )
            self.cleanup()
            raise InvalidExtensionSetup(error_message)

        repos = self.handler.get_setting("inmanta.repos", self, "")

        logger.debug(f"project.yaml created at {os.path.join(self.inmanta_project_dir.name, 'project.yml')} {repos=}.")
        with open(os.path.join(self.inmanta_project_dir.name, "project.yml"), "w+") as fd:
            metadata: typing.Mapping[str, object] = {
                "name": "Temporary project",
                "description": "Temporary project",
                "repo": yaml.safe_load(repos),
                "modulepath": modulepath,
                "downloadpath": "libs",
                "install_mode": install_mode.value,
            }
            yaml.dump(metadata, fd)

        with open(os.path.join(self.inmanta_project_dir.name, "main.cf"), "w+") as fd:
            fd.write(f"import {module_name}\n")

        return self.inmanta_project_dir.name

    def __repr__(self):
        project_dir = self.get_project_dir()
        if project_dir is None:
            project_dir = ""
        else:
            project_dir = " with a project at " + project_dir + "."
        return f"Folder {self.name} opened at {self.get_folder_path()}" + project_dir


class InmantaLSHandler(JsonRpcHandler):
    def __init__(self, instream: BaseIOStream, outstream: BaseIOStream, address):
        super(InmantaLSHandler, self).__init__(instream, outstream, address)
        self._workspace_folders = None
        self.threadpool = ThreadPoolExecutor(1)
        self.anchormap = None
        self.reverse_anchormap = None
        self.types: Optional[Dict[str, inmanta_type.Type]] = None
        self.state_lock: asyncio.Lock = asyncio.Lock()
        self.diagnostics_cache: Optional[lsp_types.PublishDiagnosticsParams] = None
        self.supported_symbol_kinds: Optional[Set[lsp_types.SymbolKind]] = None
        # compiler_venv_path is only relevant for versions of core that require a compiler venv. It is ignored otherwise.
        self.inmanta_settings: Dict[str, str] = {}

    def add_setting(self, key: str, value: str) -> None:
        """Register a default value for a setting."""
        if value is not None:
            self.inmanta_settings[key] = value

    def get_setting(self, key, folder: Optional[Folder] = None, default: Optional[str] = None) -> Optional[str]:
        """
        Fetch a given setting in the provided folder. If the setting isn't found or no folder is provided, this will look
        for the default value for this setting.
        """
        if folder:
            folder_setting = folder.get_setting(key, default)
            return folder_setting if folder_setting else self.get_default_setting(key, default)
        return self.get_default_setting(key, default)

    def get_default_setting(self, key: str, default: Optional[str] = None) -> Optional[str]:
        """Reads the default value for a setting set by the initializationOptions argument in the initialize method."""
        logger.info(f"{key=} {self.inmanta_settings=}")
        return self.inmanta_settings.get(key, default)

    def remove_folder(self, folder_uri: str) -> None:
        logger.info(self._workspace_folders)
        del self._workspace_folders[folder_uri]

    async def initialize(
        self, rootPath, rootUri, workspaceFolders: Sequence[object], capabilities: Dict[str, object], **kwargs
    ):  # noqa: N803
        logger.debug("Init: " + json.dumps(kwargs))

        if rootPath:
            logger.warning("The rootPath parameter has been deprecated in favour of the 'workspaceFolders' parameter.")
        if rootUri:
            logger.warning("The rootUri parameter has been deprecated in favour of the 'workspaceFolders' parameter.")

        if workspaceFolders is None:
            raise InvalidExtensionSetup("No workspace folder specified.")

        # Keep track of the folders opened in this workspace
        self._workspace_folders: Dict[str, Folder] = Folder.unpack_workspaces(workspaceFolders, self)

        init_options = kwargs.get("initializationOptions", None)

        if init_options:
            self.add_setting("inmanta.compiler_venv", init_options.get("compilerVenv", None))
            self.add_setting("inmanta.repos", init_options.get("repos", None))

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
                "workspace": {
                    "workspaceFolders": {
                        "supported": True,
                        "changeNotifications": True,
                    }
                },
            }
        }

    def flatten(self, line, char):
        """convert linenr char combination into a single number"""
        assert char < 100000
        return line * 100000 + char

    async def compile_and_anchor(self, folders: Optional[Sequence[Folder]] = None) -> None:
        """
        Perform a compile and compute an anchormap for the currently open folder or workspace.

        :parameter folders: When specified, only these folders will be considered instead of all the folders in the workspace.

        """

        def sync_compile_and_anchor_folder(folder: Folder):
            logger.info(f"compile and anchor for folder {folder}")

            def setup_project(folder: Folder):
                # Check that we are working inside an existing project:
                # project_file: str = os.path.join(folder, module.Project.PROJECT_FILE)
                # if os.path.exists(project_file):
                if folder.inmanta_project_dir:
                    # project_dir: str = folder.inmanta_project_dir.name
                    project_dir: str = folder.get_project_dir()
                    logger.info(f"using  existing project {project_dir}")
                else:
                    # Create a temporary project
                    project_dir = folder.create_tmp_project()
                    logger.info(f"New project created: TMP dir {project_dir}")

                if LEGACY_MODE_COMPILER_VENV:
                    compiler_venv_path: Optional[str] = self.get_setting("inmanta.compiler_venv", folder, None)
                    if compiler_venv_path:
                        logger.debug("Using venv path " + str(compiler_venv_path))
                        module.Project.set(module.Project(project_dir, venv_path=compiler_venv_path))
                    else:
                        module.Project.set(module.Project(project_dir))
                else:
                    module.Project.set(module.Project(project_dir))
                    module.Project.get().install_modules()

            # reset all
            resources.resource.reset()
            handler.Commander.reset()

            setup_project(folder)

            # can't call compiler.anchormap and compiler.get_types_and_scopes directly because of inmanta/inmanta#2471

            compiler_instance: compiler.Compiler = compiler.Compiler()
            (statements, blocks) = compiler_instance.compile()
            scheduler_instance = scheduler.Scheduler()
            anchormap = scheduler_instance.anchormap(compiler_instance, statements, blocks)
            self.types = scheduler_instance.get_types()

            def treeify(iterator):
                tree = IntervalTree()
                for f, t in iterator:
                    start = self.flatten(f.lnr - 1, f.start_char - 1)
                    end = self.flatten(f.end_lnr - 1, f.end_char - 1)
                    tree[start:end] = t
                return tree

            if not self.anchormap:
                self.anchormap = {}

            folder_anchor_map = {os.path.realpath(k): treeify(v) for k, v in groupby(anchormap, lambda x: x[0].file)}

            self.anchormap = {**self.anchormap, **folder_anchor_map}

            def treeify_reverse(iterator):
                tree = IntervalTree()
                for f, t in iterator:
                    if isinstance(t, Range):
                        start = self.flatten(t.lnr - 1, t.start_char - 1)
                        end = self.flatten(t.end_lnr - 1, t.end_char - 1)
                        if start <= end:
                            tree[start:end] = f
                return tree

            if not self.reverse_anchormap:
                self.reverse_anchormap = {}

            folder_reverse_anchormap = {
                os.path.realpath(k): treeify_reverse(v) for k, v in groupby(anchormap, lambda x: x[1].file)
            }
            self.reverse_anchormap = {**self.anchormap, **folder_reverse_anchormap}

        async def sync_compile_and_anchor_folders(folders: Optional[Sequence[Folder]]) -> None:
            if folders is None or folders[0] is None:
                # No folders specified -> compile and anchor all folders in the workspace
                folders = self._workspace_folders.values()

            for folder in folders:
                # sync_compile_and_anchor_folder(folder)
                # run synchronous part in executor to allow context switching while awaiting
                await asyncio.get_event_loop().run_in_executor(self.threadpool, sync_compile_and_anchor_folder, folder)
                await self.publish_diagnostics(None)
                logger.info(f"Compilation succeeded for folder {folder}")

        try:
            if self.shutdown_requested:
                return
            await sync_compile_and_anchor_folders(folders)
            # run synchronous part in executor to allow context switching while awaiting
            # await self.publish_diagnostics(None)
            # logger.info("Compilation succeeded")
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

        except Exception as e:
            logger.debug(e)

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
        self._cleanup_tmp_projects()
        self.threadpool.shutdown(cancel_futures=True)

    def _cleanup_tmp_projects(self):
        for workspace in self._workspace_folders.values():
            workspace.cleanup()

    async def exit(self, **kwargs):
        self.running = False


    async def textDocument_didSave(self, **kwargs):  # noqa: N802
        logger.info(f"document saved, should probably do something here {kwargs=}")
        # {'textDocument': {'uri': 'file:///home/hugo/tmp/tmp_module/test-module-v2/model/_init.cf'}}
        try:
            # r = await self.dispatch_method(1, "getWorkspaceFolder", file_uri)
            # await self.send_notification("textDocument/publishDiagnostics", publish_params.dict())
            # path = URI(file_uri).path
            file_uri: URI = kwargs["textDocument"]["uri"]
            folder = await self.send_notification("workspace/getWorkspaceFolder", {"uri": file_uri})

            # logger.info(f"{self.anchormap.keys()=}")
            # logger.info(f"{self.reverse_anchormap.keys()=}")
            logger.debug(f"{folder}")

            # folder = self.getWorkspaceFolder(file_uri)
        except KeyError as e:
            logger.debug(f"{e}")
            folder = None

        await self.compile_and_anchor([folder])

    async def workspace_DidChangeConfiguration(self, **kwargs):  # noqa: N802
        logger.debug(f"workspace_DidChangeConfiguration, should probably do something HERE {kwargs=}")
        await self.compile_and_anchor()


    async def workspace_didChangeWorkspaceFolders(self, **kwargs):  # noqa: N802
        logger.debug(f"Change in the workspace detected {kwargs=}")
        event = kwargs.get("event", None)
        if event:
            added = Folder.unpack_workspaces(event["added"])
            removed = Folder.unpack_workspaces(event["removed"])

            logger.debug(f"before change {self._workspace_folders}")
            logger.debug(f"{added=}")
            logger.debug(f"{removed=}")

            self._workspace_folders.update(added)
            logger.debug(f"middle change {self._workspace_folders}")

            self._workspace_folders = {k: v for k, v in self._workspace_folders.items() if k not in removed.keys()}

            logger.debug(f"after change {self._workspace_folders}")
            for folder in removed.values():
                folder.cleanup()

            await self.compile_and_anchor()

    def convert_location(self, loc):
        prefix = "file:///" if os.name == "nt" else "file://"
        if isinstance(loc, Range):
            return {
                "uri": prefix + loc.file,
                "range": {
                    "start": {"line": loc.lnr - 1, "character": loc.start_char - 1},
                    "end": {"line": loc.end_lnr - 1, "character": loc.end_char - 1},
                },
            }
        else:
            return {
                "uri": prefix + loc.file,
                "range": {
                    "start": {"line": loc.lnr - 1, "character": 0},
                    "end": {"line": loc.lnr, "character": 0},
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
