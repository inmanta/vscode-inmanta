import json
import logging
import socket

import pytest
import os

from tornado.iostream import IOStream
from inmantals.jsonrpc import JsonRpcServer
from inmantals.server import InmantaLSHandler
from tornado.tcpclient import TCPClient


class JsonRPC(object):
    def __init__(self, ios: IOStream) -> None:
        self.ios = ios
        self.rpqnr = 0

    async def write(self, body):
        body = body.encode("utf-8")
        length = len(body)
        header = "Content-Length: %d\r\n\r\n" % length
        header = header.encode(encoding="ascii")
        await self.ios.write(header)
        await self.ios.write(body)

    async def call(self, method, **kwargs):
        body = {}

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
        return result["result"]


@pytest.fixture
async def server(event_loop):
    server = JsonRpcServer(InmantaLSHandler)
    server.listen(6352)
    yield server
    server.stop()


@pytest.fixture
async def client(server):
    ios = await TCPClient().connect("127.0.0.1", 6352, af=socket.AddressFamily.AF_INET)
    client = JsonRPC(ios)
    yield client
    client.ios.close()


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


@pytest.mark.timeout(5)
@pytest.mark.asyncio
async def test_connection(client, caplog):
    caplog.set_level(logging.DEBUG)

    path = os.path.join(os.path.dirname(__file__), "project")
    ret = await client.call("initialize", rootPath=path, rootUri=f"file://{path}")
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

    ret = await client.call("exit")
    await client.assert_one(ret)
