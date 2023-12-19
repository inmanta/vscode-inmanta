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
import contextlib
import json
import logging
import os
import re
import tempfile
import textwrap
import typing
from collections import abc
from concurrent.futures.thread import ThreadPoolExecutor
from itertools import chain
from typing import Dict, Iterator, List, Optional, Sequence, Set, Tuple, Type
from urllib.parse import unquote, urlparse

from tornado.iostream import BaseIOStream

import inmanta.ast.type as inmanta_type
import pkg_resources
import yaml
from inmanta import compiler, env, module, resources
from inmanta.agent import handler
from inmanta.ast import CompilerException, Location, Range
from inmanta.ast.entity import Entity, Implementation
from inmanta.config import is_bool
from inmanta.execute import scheduler
from inmanta.module import Project
from inmanta.plugins import Plugin
from inmanta.util import groupby
from inmantals import lsp_types
from inmantals.jsonrpc import InvalidParamsException, JsonRpcHandler, MethodNotFoundException
from intervaltree.interval import Interval
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

SUPPORTS_PROJECT_PIP_INDEX: bool = CORE_VERSION is not None and CORE_VERSION >= version.Version("11.0.0.dev")


if SUPPORTS_PROJECT_PIP_INDEX:
    from inmanta.data import PipConfig

try:
    from inmanta.ast import AnchorTarget
except ImportError:
    """
    Before version 8.3.0.dev on core the AnchorTarget class does not exist so we will create it ourself here and transform all
    locations and ranges to AnchorTarget's where needed.
    Otherwise will return AnchorTargets where needed and the AnchorTarget class of core will be used.
    """

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
    """An instance of InmantaLSHandler can only handle one folder (i.e. not a single file) which contains a valid inmanta
    project or module."""

    def __init__(self, message: str) -> None:
        Exception.__init__(self, message)
        self.message = message


class Folder:
    """
    Wrapper class around a folder (inmanta module or inmanta project). This folder can either be standalone or live in a
    workspace alongside other folders.

    """

    folder_path: str
    inmanta_project_dir: str
    handler: "InmantaLSHandler"

    def __init__(self, root_uri: str, handler: "InmantaLSHandler"):
        folder_uri = urlparse(root_uri)
        """
        :param root_uri: path of the outermost folder that is assumed to live in a workspace
        :param handler: reference to the InmantaLSHandler responsible for this folder
        """

        self.folder_path = os.path.abspath(folder_uri.path)
        self.handler = handler  # Keep a reference to the handler for cleanup
        self.kind: Type[module.ModuleLike]

        assert self.handler.pipconfig is not None

        # Check that we are working inside an existing project:
        project_file: str = os.path.join(self.folder_path, module.Project.PROJECT_FILE)
        if os.path.exists(project_file):
            self.inmanta_project_dir = os.path.dirname(project_file)
            self.kind = module.Project
        else:
            # self.kind is set by this method
            self.inmanta_project_dir = self.create_tmp_project()

    def install_v2_module_editable_mode(self):
        """
        This method relies on the assumption that an inmanta project has already been set up and that the correct pip indexes
        have been set up through the "repos" Inmanta extension setting.
        """
        # TODO: this method is heavily inspired by https://github.com/inmanta/pytest-inmanta-lsm/blob/fffe3c9af9be030f525e3284aeaa277091f1ecc8/src/pytest_inmanta_lsm/resources/setup_project.py#L92  # NOQA E501
        # To avoid code duplication, this should be made into a method into core and we should call this method here and in
        # pytest-inmanta-lsm. Full ticket here: https://github.com/inmanta/inmanta-lsm/issues/1240

        @contextlib.contextmanager
        def env_vars(var: abc.Mapping[str, str]) -> abc.Iterator[None]:
            """
            Context manager to extend the current environment with one or more environment variables.
            """

            def set_env(set_var: abc.Mapping[str, Optional[str]]) -> None:
                for name, value in set_var.items():
                    if value is not None:
                        os.environ[name] = value
                    elif name in os.environ:
                        del os.environ[name]

            old_env: abc.Mapping = {name: os.environ.get(name, None) for name in var}
            set_env(var)
            yield
            set_env(old_env)

        project: Project = module.Project.get()
        # Make sure the virtual environment is ready
        if not project.is_using_virtual_env():
            project.use_virtual_env()

        # Load the module
        logger.info(f"Trying to load module at {self.folder_path}")
        mod = module.Module.from_path(str(self.folder_path))

        assert isinstance(mod, module.ModuleV2), type(mod)
        logger.info(f"Module {mod.name} is v2, we will attempt to install it")

        logger.debug(f"{project.__dict__=}")

        if SUPPORTS_PROJECT_PIP_INDEX:
            project.virtualenv.install_for_config(
                requirements=[],
                paths=[env.LocalPackagePath(mod.path, editable=True)],
                config=PipConfig(**self.handler.pipconfig),
            )
        else:
            # Install all v2 modules in editable mode using the project's configured package sources
            urls: abc.Sequence[str] = project.module_source.urls
            if not urls:
                raise Exception("No package repos configured for project")

            # plain Python install so core does not apply project's sources -> we need to configure pip index ourselves
            with env_vars(
                {
                    "PIP_INDEX_URL": urls[0],
                    "PIP_PRE": "0" if project.install_mode == module.InstallMode.release else "1",
                    "PIP_EXTRA_INDEX_URL": " ".join(urls[1:]),
                }
            ):
                logger.info("Installing modules from source: %s", mod.name)
                project.virtualenv.install_from_source([env.LocalPackagePath(mod.path, editable=True)])

        project.install_modules()

    def create_tmp_project(self) -> str:
        """
        When working on a module, an inmanta project is created in a temporary directory.
        The caller of this method is responsible for calling this object's cleanup method once the temporary directory is no
        longer used.
        """
        tmp_dir: tempfile.TemporaryDirectory = tempfile.TemporaryDirectory()
        inmanta_project_dir: str = os.path.abspath(tmp_dir.name)
        logger.debug("Temporary project created at %s.", inmanta_project_dir)

        os.mkdir(os.path.join(inmanta_project_dir, "libs"))

        install_mode = module.InstallMode.master
        folder_path = unquote(self.folder_path)

        def _get_module_name():
            module_name: Optional[str] = None
            libs_folder = os.path.join(inmanta_project_dir, "libs")
            if CORE_VERSION < version.Version("5.dev"):
                v1_metadata_file: str = os.path.join(self.folder_path, module.Module.MODULE_FILE)

                if os.path.exists(v1_metadata_file):
                    mv1 = module.Module(project=None, path=self.folder_path)
                    module_name = mv1.name
                    os.symlink(self.folder_path, os.path.join(libs_folder, module_name), target_is_directory=True)
                    self.kind = module.Module
            else:
                v2_metadata_file: str = os.path.join(folder_path, module.ModuleV2.MODULE_FILE)
                v1_metadata_file: str = os.path.join(folder_path, module.ModuleV1.MODULE_FILE)

                if os.path.exists(unquote(v1_metadata_file)):
                    mv1 = module.ModuleV1(project=None, path=folder_path)
                    module_name = mv1.name
                    os.symlink(folder_path, os.path.join(libs_folder, module_name), target_is_directory=True)
                    self.kind = module.ModuleV1

                elif os.path.exists(unquote(v2_metadata_file)):
                    mv2 = module.ModuleV2(project=None, path=folder_path, is_editable_install=True)
                    module_name = mv2.name
                    self.kind = module.ModuleV2
            return module_name

        module_name = _get_module_name()

        if not module_name:
            error_message: str = (
                "The Inmanta extension only works on projects and modules. "
                f"Please make sure the folder opened at {folder_path} is a valid "
                "[project](https://docs.inmanta.com/community/latest/model_developers/project_creation.html)"
                " or "
                "[module](https://docs.inmanta.com/community/latest/model_developers/module_creation.html)"
            )
            tmp_dir.cleanup()

            raise InvalidExtensionSetup(error_message)

        def _generate_project_yml() -> dict[str, object]:
            """
            Generate the content of the project.yml for the temporary project as a python dict.
            """
            content = {
                "name": "Temporary project",
                "description": "Temporary project",
                "modulepath": "libs",
                "downloadpath": "libs",
            }
            if SUPPORTS_PROJECT_PIP_INDEX:
                content["pip"] = self.handler.pipconfig
            else:
                content["install_mode"]: install_mode.value
                if self.handler.repos:
                    content["repo"] = self.handler.repos

            return content

        project_yml_path = os.path.join(inmanta_project_dir, "project.yml")
        with open(project_yml_path, "w+") as fd:
            content = _generate_project_yml()
            yaml.dump(content, fd)
            logger.debug("project.yml created at %s: %s", project_yml_path, content)

        def _get_name_spaces(curdir: str, prefix: str) -> List[str]:
            """
            Returns a list of all inmanta namespaces living under a root directory
            """
            files: List[str] = []
            init_cf = os.path.join(curdir, "_init.cf")
            if not os.path.exists(init_cf):
                return files

            for entry in os.listdir(curdir):
                sub_path = os.path.join(curdir, entry)
                if os.path.isdir(sub_path):
                    files.extend(_get_name_spaces(sub_path, prefix + "::" + entry))
                elif os.path.splitext(sub_path)[1] == ".cf":
                    if entry != "_init.cf":
                        files.append(prefix + "::" + os.path.splitext(entry)[0])
                    else:
                        files.append(prefix)
            return files

        name_spaces = _get_name_spaces(os.path.join(folder_path, "model"), module_name)

        with open(os.path.join(inmanta_project_dir, "main.cf"), "w+") as fd:
            for name in name_spaces:
                fd.write(f"import {name}\n")

        pattern = os.path.join(inmanta_project_dir, "libs", module_name)
        compiled_pattern = re.compile(re.escape(pattern))

        # Register this temporary project in the InmantaLSHandler so that it gets properly cleaned up on server shutdown.
        self.handler.register_tmp_project(tmp_project=tmp_dir, module_in_tmp_libs=compiled_pattern)
        return inmanta_project_dir

    def install_project(self, attach_cf_cache: bool):
        """
        This method is assumed to be called in an iso6+ context
        """
        module.Project.set(module.Project(self.inmanta_project_dir, attach_cf_cache=attach_cf_cache))
        env_path = module.Project.get().virtualenv.env_path
        logger.info("Installing project at %s in env %s.", self.inmanta_project_dir, env_path)
        if self.kind == module.ModuleV2:
            # If the open folder is a v2 module we must install it in editable mode in the temporary project using the pip
            # indexes set in the "repos" extension setting for its dependencies.
            self.install_v2_module_editable_mode()

        else:
            module.Project.get().install_modules()

    def __str__(self):
        return f"Folder opened at {self.folder_path}" + " with a project at " + self.inmanta_project_dir


class InmantaLSHandler(JsonRpcHandler):
    def __init__(self, instream: BaseIOStream, outstream: BaseIOStream, address):
        super(InmantaLSHandler, self).__init__(instream, outstream, address)
        # If the currently open folder is a module, a temporary project will be created.
        self.tmp_project: Optional[tempfile.TemporaryDirectory] = None
        self.root_folder: Optional[Folder] = None
        self.threadpool = ThreadPoolExecutor(1)
        self.anchormap = None
        self.reverse_anchormap = None
        self.types: Optional[Dict[str, inmanta_type.Type]] = None
        self.state_lock: asyncio.Lock = asyncio.Lock()
        self.diagnostics_cache: Optional[lsp_types.PublishDiagnosticsParams] = None
        self.supported_symbol_kinds: Optional[Set[lsp_types.SymbolKind]] = None

        # compiler_venv_path is only relevant for versions of core that require a compiler venv. It is ignored otherwise.
        self.compiler_venv_path: Optional[str] = None
        # The scope for the 'compilerVenv' and 'repos' settings in the package.json are set to 'resource' to allow different
        # values for each folder in the workspace. See https://github.com/Microsoft/vscode/wiki/Adopting-Multi-Root-Workspace-APIs#settings  # NOQA E501
        self.repos: Optional[str] = None
        self.pipconfig: Optional[dict] = None

    async def initialize(
        self,
        capabilities: Dict[str, object],
        *,
        workspaceFolders: Optional[Sequence[Dict]] = None,
        rootPath=None,
        rootUri=None,
        **kwargs,
    ):  # noqa: N803
        logger.debug("Init: %s", json.dumps(kwargs))
        logger.debug("workspaceFolders=%s", workspaceFolders)
        logger.debug("rootPath=%s", rootPath)
        logger.debug("rootUri=%s", rootUri)
        logger.debug("kwargs=%s", kwargs)

        if rootPath:
            logger.warning("The rootPath parameter has been deprecated in favour of the 'workspaceFolders' parameter.")

        if workspaceFolders is None:
            if rootUri is None:
                raise InvalidExtensionSetup("No workspace folder or rootUri specified.")
            workspaceFolders = [rootUri]
            workspace_folder = lsp_types.WorkspaceFolder(uri=rootUri, name=os.path.dirname(urlparse(rootUri).path))
        else:
            workspace_folder = lsp_types.WorkspaceFolder(**workspaceFolders[0])

        if len(workspaceFolders) > 1:
            raise InvalidExtensionSetup(
                "InmantaLSHandler can only handle a single folder. Instantiate one InmantaLSHandler per folder instead."
            )

        init_options = kwargs.get("initializationOptions", None)
        logger.debug("init_options= %s", init_options)

        if init_options:
            self.compiler_venv_path = init_options.get(
                "compilerVenv", os.path.join(os.path.abspath(urlparse(str(workspace_folder.uri)).path), ".env-ls-compiler")
            )
            self.repos = init_options.get("repos", None)
            logger.debug("self.repos= %s", self.repos)
            # Make sure we leave pip config options that are unset in the Inmanta extension's config (i.e. null values
            # from the settings.json) out of the pipconfig, so the default behaviour from core is followed.
            self.pipconfig = {k: v for k, v in init_options.get("pip", {}).items() if v is not None}

            logger.debug("self.pipconfig= %s", self.pipconfig)

        # Keep track of the root folder opened in this workspace
        self.root_folder: Folder = Folder(str(workspace_folder.uri), self)
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

    def replace_tmp_path(self, path: str) -> str:
        """
        This method assumes a module is opened as the root folder. This method makes
        code navigation transparent to the user by replacing
            - The path to the module in the temporary project's libs folder
            by
            - The path to the module opened as the root folder

        :param path: The path in which the replacement should occur.
        """
        return re.sub(pattern=self.module_in_tmp_libs, repl=self.root_folder.folder_path, string=path)

    async def compile_and_anchor(self) -> None:
        """
        Perform a compile and compute an anchormap for the currently open folder.
        """

        def sync_compile_and_anchor() -> None:
            logger.info("Compile and anchor for root folder %s.", self.root_folder)

            def setup_project(folder: Folder):
                useCache: bool = is_bool(os.getenv("INMANTA_COMPILER_CACHE", "True"))
                # Check that we are working inside an existing project:
                if not folder.inmanta_project_dir:
                    raise InvalidExtensionSetup("No inmanta project found.")

                if LEGACY_MODE_COMPILER_VENV:
                    if self.compiler_venv_path:
                        module.Project.set(module.Project(folder.inmanta_project_dir, venv_path=self.compiler_venv_path))
                    else:
                        module.Project.set(module.Project(folder.inmanta_project_dir))
                else:
                    folder.install_project(attach_cf_cache=useCache)

            # reset all
            resources.resource.reset()
            handler.Commander.reset()

            setup_project(self.root_folder)

            # can't call compiler.anchormap and compiler.get_types_and_scopes directly because of inmanta/inmanta#2471

            compiler_instance: compiler.Compiler = compiler.Compiler()
            (statements, blocks) = compiler_instance.compile()
            scheduler_instance = scheduler.Scheduler()
            # call anchormap_extended if it exists, otherwise call anchormap to stay backward compatible.
            anchormap: Sequence[Tuple[Location, AnchorTarget]] = (
                scheduler_instance.get_anchormap(compiler_instance, statements, blocks)
                if hasattr(scheduler_instance, "get_anchormap")
                else [
                    # Make sure everything is an AnchorTarget: this is for backward compatibility
                    (s, AnchorTarget(t)) if isinstance(t, Location) else (s, t)
                    for s, t in scheduler_instance.anchormap(compiler_instance, statements, blocks)
                ]
            )
            self.types = scheduler_instance.get_types()

            def treeify(iterator):
                tree = IntervalTree()
                for f, t in iterator:
                    start = self.flatten(f.lnr - 1, f.start_char - 1)
                    end = self.flatten(f.end_lnr - 1, f.end_char - 1)
                    tree[start:end] = t
                return tree

            def compute_anchormap(anchormap):
                self.anchormap = {}
                for k, v in groupby(anchormap, lambda x: x[0].file):
                    if self.tmp_project:
                        k = self.replace_tmp_path(k)
                    self.anchormap[os.path.realpath(k)] = treeify(v)

            compute_anchormap(anchormap)

            def treeify_reverse(iterator):
                tree = IntervalTree()
                for f, t in iterator:
                    if isinstance(t.location, Range):
                        start = self.flatten(t.location.lnr - 1, t.location.start_char - 1)
                        end = self.flatten(t.location.end_lnr - 1, t.location.end_char - 1)
                        if start <= end:
                            tree[start:end] = f
                return tree

            def compute_reverse_anchormap(anchormap):
                self.reverse_anchormap = {}
                for k, v in groupby(anchormap, lambda x: x[1].location.file):
                    if self.tmp_project:
                        k = self.replace_tmp_path(k)
                    self.reverse_anchormap[os.path.realpath(k)] = treeify_reverse(v)

            compute_reverse_anchormap(anchormap)

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
        if CORE_VERSION < version.Version("5.dev"):
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
        logger.debug("shutdown requested...")
        if self.tmp_project:
            self.tmp_project.cleanup()
        if CORE_VERSION < version.Version("5.dev"):
            # The cancel_futures argument doesn't exist for python < 3.9 see:
            # https://docs.python.org/3.6/library/concurrent.futures.html#concurrent.futures.Executor.shutdown
            self.threadpool.shutdown()
        else:
            self.threadpool.shutdown(cancel_futures=True)
        self.shutdown_requested = True

    def register_tmp_project(self, tmp_project: tempfile.TemporaryDirectory, module_in_tmp_libs: typing.Pattern):
        """
        Bookkeeping method to keep track of things related to the currently opened module

        :param tmp_project: Temporary Inmanta project used to compile the opened module
        :param module_in_tmp_libs: Compiled regex pattern used in the replace_tmp_path method

        """
        self.tmp_project = tmp_project
        self.module_in_tmp_libs = module_in_tmp_libs

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

    def get_plugin_range_from_location(self, filename, line_number) -> Optional[Range]:
        with open(filename, "r") as f:
            contents = f.read().splitlines()[line_number - 1]
        pattern = r"def\s+(\w+)\s*\("
        match = re.search(pattern, contents)
        if match:
            start_pos = match.start(1)
            end_pos = match.end(1)
            return Range(file=filename, start_lnr=line_number, end_lnr=line_number, start_char=start_pos, end_char=end_pos)
        return None

    def convert_location(self, location: Location):
        prefix = "file:///" if os.name == "nt" else "file://"
        uri = prefix + location.file
        if self.tmp_project:
            uri = self.replace_tmp_path(uri)

        if isinstance(location, Range):
            return {
                "uri": uri,
                "range": {
                    "start": {"line": location.lnr - 1, "character": location.start_char - 1},
                    "end": {"line": location.end_lnr - 1, "character": location.end_char - 1},
                },
            }

        else:
            range = self.get_plugin_range_from_location(location.file, location.lnr)
            if range:
                return {
                    "uri": uri,
                    "range": {
                        "start": {"line": range.lnr - 1, "character": range.start_char},
                        "end": {"line": range.end_lnr - 1, "character": range.end_char},
                    },
                }
            return {
                "uri": uri,
                "range": {
                    "start": {"line": location.lnr - 1, "character": 0},
                    "end": {"line": location.lnr, "character": 0},
                },
            }

    def get_definition(self, target: AnchorTarget) -> str:
        file_path = target.location.file
        start_line = target.location.lnr - 1
        with open(file_path, "r", encoding="utf8") as f:
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

    def get_range_from_position(self, textDocument, position, anchormap) -> Optional[Interval]:
        uri = textDocument["uri"]
        url = os.path.realpath(uri.replace("file://", ""))

        if anchormap is None:
            return None

        if url not in anchormap:
            return None

        tree = anchormap[url]

        range = tree[self.flatten(position["line"], position["character"])]
        if range is None or len(range) == 0:
            return None
        return range

    async def textDocument_definition(self, textDocument, position):  # noqa: N802, N803
        range = self.get_range_from_position(textDocument, position, self.anchormap)
        if not range:
            return {}
        target: AnchorTarget = list(range)[0].data

        return self.convert_location(target.location)

    async def textDocument_references(self, textDocument, position, context):  # noqa: N802, N803  # noqa: N802, N803
        range = self.get_range_from_position(textDocument, position, self.reverse_anchormap)
        if not range:
            return {}

        return [self.convert_location(location.data) for location in range]

    async def textDocument_hover(self, textDocument, position):
        range = self.get_range_from_position(textDocument, position, self.anchormap)
        if not range:
            return {}

        data = list(range)[0].data
        docstring = textwrap.dedent(data.docstring.strip("\n")) if data.docstring else ""
        docstring = docstring.replace(" ", "&nbsp;").replace("\n", "\n\n").strip()
        try:
            definition = self.get_definition(data).strip()
        except FileNotFoundError:
            # Certain keywords e.g. "Entity" are defined internally in virtual files (e.g. 'internal').
            # Display nothing on hover if the hovered symbol is defined in a file that doesn't exist:
            return {}

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

            logger.warning("Unknown type %s, using default symbol kind", tp)
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
