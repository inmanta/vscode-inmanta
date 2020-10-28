import json
import logging
import socket
from typing import AsyncIterator, Dict, List, Optional

import pytest
import os

from tornado.iostream import IOStream
from inmantals import lsp_types
from inmantals.jsonrpc import JsonRpcServer
from inmantals.server import InmantaLSHandler
from tornado.tcpclient import TCPClient


class JsonRPC(object):
    def __init__(self, ios: IOStream) -> None:
        self.ios = ios
        self.rpqnr: int = 0

    async def write(self, body):
        body = body.encode("utf-8")
        length = len(body)
        header = "Content-Length: %d\r\n\r\n" % length
        header = header.encode(encoding="ascii")
        await self.ios.write(header)
        await self.ios.write(body)

    async def call(self, method, **kwargs) -> int:
        body: Dict[str, object] = {}

        ident = self.rpqnr
        self.rpqnr += 1

        body["id"] = ident
        body["jsonrpc"] = "2.0"
        body["method"] = method
        body["params"] = kwargs

        await self.write(json.dumps(body))
        return ident

    async def decode_header(self):
        rn = "\r\n".encode(encoding="ascii")
        header = True
        contentlength = -1
        while header:
            data = await self.ios.read_until(rn)
            data = data.decode("ascii")
            if data == "\r\n":
                header = False
            else:
                parts = data[0:-2].split(": ", 2)
                if len(parts) != 2:
                    assert False, "Invalid header: " + str(header)
                header, value = parts
                if header == "Content-Length":
                    contentlength = int(value)
                if header == "Content-Type":
                    if value != "application/vscode-jsonrpc; charset=utf-8":
                        raise Exception("unknown content type %s" % value)
        return contentlength

    async def read_one(self):
        length = await self.decode_header()
        if length == -1:
            assert False
        body = await self.ios.read_bytes(length)
        body = body.decode("utf8")
        return body

    async def assert_one(self, id):
        result = json.loads(await self.read_one())
        assert result["id"] == id
        if "error" in result:
            assert False, "error in response %s: %s" % (id, result["error"])
        return result["result"]


@pytest.fixture
async def server(event_loop) -> AsyncIterator[JsonRpcServer]:
    server = JsonRpcServer(InmantaLSHandler)
    server.listen(6352)
    yield server
    server.stop()


@pytest.fixture
async def client(server) -> AsyncIterator[JsonRPC]:
    ios = await TCPClient().connect("127.0.0.1", 6352, af=socket.AddressFamily.AF_INET)
    client = JsonRPC(ios)
    yield client
    client.ios.close()


async def initialize_project(client: JsonRPC, project: str, client_capabilities: Optional[Dict[str, object]] = None) -> None:
    """
    Initializes the server with the basic_test project.
    """
    if client_capabilities is None:
        client_capabilities = {}
    path = os.path.join(os.path.dirname(__file__), "project")
    ret = await client.call("initialize", rootPath=path, rootUri=f"file://{path}", capabilities=client_capabilities)
    await client.assert_one(ret)

    ret = await client.call("initialized")
    await client.assert_one(ret)


async def assert_lnr(client):
    path = os.path.join(os.path.dirname(__file__), "project")
    ret = await client.call(
        "textDocument/definition",
        textDocument={"uri": f"file://{path}/main.cf"},
        position={"line": 5, "character": 2},
    )
    result = await client.assert_one(ret)
    assert result == {
        "uri": f"file://{path}/main.cf",
        "range": {
            "start": {"line": 0, "character": 7},
            "end": {"line": 0, "character": 11},
        },
    }


async def assert_lnr_reverse(client):
    path = os.path.join(os.path.dirname(__file__), "project")
    ret = await client.call(
        "textDocument/references",
        textDocument={"uri": f"file://{path}/main.cf"},
        position={"line": 0, "character": 8},
        context={}
    )
    result = await client.assert_one(ret)
    assert result == [{
        "uri": f"file://{path}/main.cf",
        "range": {
            "start": {"line": 5, "character": 0},
            "end": {"line": 5, "character": 4},
        },
    }]


@pytest.mark.timeout(5)
@pytest.mark.asyncio
async def test_connection(client, caplog):
    caplog.set_level(logging.DEBUG)

    path = os.path.join(os.path.dirname(__file__), "project")
    ret = await client.call("initialize", rootPath=path, rootUri=f"file://{path}", capabilities={})
    result = await client.assert_one(ret)
    assert result == {
        "capabilities": {
            "textDocumentSync": {
                "openClose": True,
                "change": 1,
                "willSave": False,
                "willSaveWaitUntil": False,
                "save": {"includeText": False},
            },
            "definitionProvider": True,
            "referencesProvider": True,
            "workspaceSymbolProvider": {"workDoneProgress": False}
        }
    }

    ret = await client.call("initialized")
    result = await client.assert_one(ret)
    # find DEBUG inmanta.execute.scheduler:scheduler.py:196 Anchormap took 0.006730 seconds
    assert "Anchormap took" in caplog.text
    caplog.clear()

    await assert_lnr(client)

    ret = await client.call("textDocument/didSave")
    result = await client.assert_one(ret)
    # find DEBUG inmanta.execute.scheduler:scheduler.py:196 Anchormap took 0.006730 seconds
    assert "Anchormap took" in caplog.text
    caplog.clear()

    await assert_lnr(client)
    await assert_lnr_reverse(client)

    ret = await client.call("exit")
    await client.assert_one(ret)


@pytest.mark.timeout(5)
@pytest.mark.asyncio
async def test_symbol_provider(client: JsonRPC) -> None:
    ret: int
    result: object

    await initialize_project(client, "project")

    ret = await client.call("workspace/symbol", query="test")
    result = await client.assert_one(ret)
    assert isinstance(result, list)
    symbol_info: List[lsp_types.SymbolInformation] = [lsp_types.SymbolInformation.parse_obj(symbol) for symbol in result]

    project_dir: str = os.path.abspath(os.path.join(os.path.dirname(__file__), "project"))
    uri_main: str = "file://%s" % os.path.join(project_dir, "main.cf")
    mymodule_dir: str = os.path.join(project_dir, "libs", "mymodule")
    uri_mymodule_model: str = "file://%s" % os.path.join(mymodule_dir, "model", "_init.cf")
    uri_mymodule_plugins: str = "file://%s" % os.path.join(mymodule_dir, "plugins", "__init__.py")

    assert symbol_info == [
        lsp_types.SymbolInformation(
            name="__config__::my_test_type",
            kind=lsp_types.SymbolKind.Class,
            location=lsp_types.Location(
                uri=uri_main,
                range=lsp_types.Range(
                    start=lsp_types.Position(line=1, character=8), end=lsp_types.Position(line=1, character=20)
                ),
            ),
        ),
        lsp_types.SymbolInformation(
            name="mymodule::Test",
            kind=lsp_types.SymbolKind.Class,
            location=lsp_types.Location(
                uri=uri_mymodule_model,
                range=lsp_types.Range(
                    start=lsp_types.Position(line=0, character=7), end=lsp_types.Position(line=0, character=11)
                ),
            ),
        ),
        lsp_types.SymbolInformation(
            name="mymodule::test",
            kind=lsp_types.SymbolKind.Constructor,
            location=lsp_types.Location(
                uri=uri_mymodule_model,
                range=lsp_types.Range(
                    start=lsp_types.Position(line=4, character=15), end=lsp_types.Position(line=4, character=19)
                ),
            ),
        ),
        lsp_types.SymbolInformation(
            name="mymodule::plugin_test",
            kind=lsp_types.SymbolKind.Function,
            location=lsp_types.Location(
                uri=uri_mymodule_plugins,
                range=lsp_types.Range(
                    start=lsp_types.Position(line=4, character=0), end=lsp_types.Position(line=4, character=1)
                ),
            ),
        ),
        lsp_types.SymbolInformation(
            name="test_attribute",
            kind=lsp_types.SymbolKind.Field,
            location=lsp_types.Location(
                uri=uri_mymodule_model,
                range=lsp_types.Range(
                    start=lsp_types.Position(line=1, character=0), end=lsp_types.Position(line=1, character=0)
                ),
            ),
            containerName="mymodule::Test",
        ),
    ]
