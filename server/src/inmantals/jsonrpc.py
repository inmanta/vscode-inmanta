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
import sys
from enum import Enum
from json.decoder import JSONDecodeError

from tornado.ioloop import IOLoop
from tornado.iostream import BaseIOStream, StreamClosedError
from tornado.locks import Semaphore
from tornado.tcpserver import TCPServer

logger = logging.getLogger(__name__)


def generate_safe_log_file():
    # This env variable will only be set for testing purpose
    file_name = os.getenv("LOG_PATH", None)
    if file_name is not None:
        return file_name

    import tempfile
    import time

    file_name = "vscode-inmanta-%08x.log" % round(time.time() * 1000000)
    while os.path.exists(os.path.join(tempfile.gettempdir(), file_name)):
        file_name = "vscode-inmanta-%08x.log" % round(time.time() * 1000000)
    return os.path.join(tempfile.gettempdir(), file_name)


class ErrorCodes(Enum):
    ParseError = -32700
    InvalidRequest = -32600
    MethodNotFound = -32601
    InvalidParams = -32602
    InternalError = -32603
    ServerErrorStart = -32099
    ServerErrorEnd = -32000
    ServerNotInitialized = -32002
    UnknownErrorCode = -32001
    RequestCancelled = -32800


class JsonRpcException(Exception):
    def __init__(self, message, id, **kwargs):
        super(JsonRpcException, self).__init__(message)
        self.id = id
        self.data = kwargs
        self.message = message

    def get_error_code(self):
        raise NotImplementedError()

    def to_dict(self):
        error = {"code": self.get_error_code().value, "message": self.message}

        if self.data is not None:
            error["data"] = self.data

        return {"jsonrpc": "2.0", "id": self.id, "error": error}


class ParseException(JsonRpcException):
    def __init__(self):
        super(ParseException, self).__init__("Could not parse JSON", None)

    def get_error_code(self):
        return ErrorCodes.ParseError


class InvalidRequestException(JsonRpcException):
    def get_error_code(self):
        return ErrorCodes.InvalidRequest


class InternalErrorException(JsonRpcException):
    def get_error_code(self):
        return ErrorCodes.InternalError


class MethodNotFoundException(JsonRpcException):
    def get_error_code(self):
        return ErrorCodes.MethodNotFound


class InvalidParamsException(JsonRpcException):
    def get_error_code(self):
        return ErrorCodes.InvalidParams


class JsonRpcServer(TCPServer):
    def __init__(self, delegate):
        """
        :param delegate: a class of which an instance is created for each connection, subclass of JsonRpcHandler
        """
        super(JsonRpcServer, self).__init__()
        if not issubclass(delegate, JsonRpcHandler):
            raise Exception("delegate must be a subclass of JsonRpcHandler")
        self.delegate = delegate

    async def handle_stream(self, stream, address):
        f = asyncio.ensure_future(self.delegate(stream, stream, address).start())
        f.add_done_callback(lambda fx: fx.result())


class JsonRpcHandler(object):
    def __init__(self, instream: BaseIOStream, outstream: BaseIOStream, address):
        self.instream = instream
        self.outstream = outstream
        self.address = address
        self.running = True
        self.shutdown_requested = False
        self.io_loop = IOLoop.current()
        self.writelock = Semaphore(1)

        # Setting up logging for the LServer
        self.log_file = generate_safe_log_file()
        formatter = logging.Formatter(fmt="%(asctime)s %(name)-25s%(levelname)-8s%(message)s")
        log_file_stream = logging.FileHandler(self.log_file)
        log_file_stream.setLevel(logging.DEBUG)
        log_file_stream.setFormatter(formatter)
        log_stderr = logging.StreamHandler(sys.stderr)
        log_stderr.setLevel(logging.INFO)
        log_stderr.setFormatter(formatter)

        logging.basicConfig(level=logging.DEBUG)

        logging.root.handlers = [log_file_stream, log_stderr]

    def assert_field(self, message, field, value=None, id=None):
        if field not in message:
            raise InvalidRequestException("header %s not found" % field, id)
        if value is not None and message[field] != value:
            raise InvalidRequestException(
                "expected header %s to be %s but was %s" % (field, value, message[field]),
                id,
            )
        return message[field]

    async def decode_header(self):
        rn = "\r\n".encode(encoding="ascii")
        header = True
        contentlength = -1
        while header:
            data = await self.instream.read_until(rn)
            data = data.decode("ascii")
            if data == "\r\n":
                header = False
            else:
                parts = data[0:-2].split(": ", 2)
                if len(parts) != 2:
                    logger.error("Invalid header: " + str(header))
                    return -1
                header, value = parts
                if header == "Content-Length":
                    contentlength = int(value)
                if header == "Content-Type":
                    if value != "application/vscode-jsonrpc; charset=utf-8":
                        logger.warn("unknown content type %s" % value)
        return contentlength

    async def send(self, body: str):
        with (await self.writelock.acquire()):
            body = body.encode("utf-8")
            length = len(body)
            header = "Content-Length: %d\r\n\r\n" % length
            header = header.encode(encoding="ascii")
            await self.outstream.write(header)
            await self.outstream.write(body)

    async def return_error(self, excn: JsonRpcException):
        body = json.dumps(excn.to_dict())
        await self.send(body)

    async def return_result(self, id, result):
        body = {"jsonrpc": "2.0", "id": id, "result": result}
        body = json.dumps(body)
        await self.send(body)

    async def send_notification(self, method, params):
        body = {"jsonrpc": "2.0", "method": method, "params": params}
        body = json.dumps(body)
        await self.send(body)

    async def start(self):
        self.running = True

        try:
            while self.running:
                length = await self.decode_header()
                if length == -1:
                    self.shutdown_requested = True
                    self.running = False
                    return

                body = await self.instream.read_bytes(length)
                body = body.decode("utf8")
                future = asyncio.ensure_future(self.decode_and_dispatch(body))
                self.io_loop.add_future(future, lambda f: f.result())
        except StreamClosedError:
            pass
        finally:
            self.instream.close()
            self.outstream.close()

    async def decode_and_dispatch(self, body):
        try:
            body = json.loads(body)
            if "id" in body:
                id = body["id"]
            else:
                id = None
            self.assert_field(body, "jsonrpc", "2.0", id=id)
            await self.dispatch(body, id)
        except JSONDecodeError:
            logger.debug("Could not parse message", exc_info=True)
            await self.return_error(ParseException())
        except JsonRpcException as e:
            logger.debug("Exception during processing", exc_info=True)
            await self.return_error(e)
        except Exception:
            logger.error("exception during call handling", exc_info=True)

    async def dispatch(self, body, id):
        if "method" in body:
            # is a request or notification call
            method = body["method"]
            if "params" in body:
                params = body["params"]
            else:
                params = {}
            try:
                result = await self.dispatch_method(id, method, params)
                # if it has no id, it is a notification and we don't send result
                if id is not None:
                    logger.debug("dispatching result %s", result)
                    await self.return_result(id, result)
            except JsonRpcException as e:
                logger.debug("exception occurred during method handling", exc_info=True)
                # no exceptions on notifications
                if id is not None:
                    # force correct id
                    e.id = id
                    raise
            except Exception as e:
                logger.debug("exception occurred during method handling ", exc_info=True)
                if id is not None:
                    # no exceptions on notifications
                    raise InternalErrorException(str(e), id)
        elif "error" in body:
            logger.debug("error: %s %s", id, body)
        elif "result" in body:
            logger.debug("result: %s %s", id, body)
        else:
            raise InvalidRequestException("no method, error or result field", id)

    async def dispatch_method(self, id, method, params):
        raise MethodNotFoundException("method %s not found" % method, id)
