# Copyright 2017 Palantir Technologies, Inc.
import json
import logging
import uuid
from inmanta.lsp.jsonrpc import JsonRpcHandler, MethodNotFoundException, InvalidParamsException
from tornado import gen

logger = logging.getLogger(__name__)


loc = {
    "uri": '',
    "range": {
        "start": {"line": 7, "character": 9},
        "end": {"line": 7, "character": 30}
    }
}


class InmantaPly(JsonRpcHandler):

    @gen.coroutine
    def initialize(self, **kwargs):
        print("Init: ", json.dumps(kwargs))
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

    @gen.coroutine
    def initialized(self):
        pass

    @gen.coroutine
    def shutdown(self, **kwargs):
        print("initialized: ", json.dumps(kwargs))

    @gen.coroutine
    def textDocument_didOpen(self, **kwargs):
        print("textDocument_didOpen: ", json.dumps(kwargs))

    @gen.coroutine
    def textDocument_didClose(self, **kwargs):
        print("textDocument_didOpen: ", json.dumps(kwargs))

    @gen.coroutine
    def textDocument_definition(self, textDocument, position):
        loc["uri"] = textDocument["uri"]
        print("LOC!", textDocument, position)
        return loc

    def mangle(self, name):
        return name.replace("/", "_")

    @gen.coroutine
    def dispatch_method(self, id, method, params):
        pymethod = self.mangle(method)

        pym = getattr(self, pymethod, None)

        if pym is None:
            logger.debug("Call to unexisting method %s params %s", method, params)
            raise MethodNotFoundException("Could not find method %s" % method, id)

        try:
            result = yield pym(**params)
        except TypeError as e:
            raise InvalidParamsException(str(e), id)

        return result

    @gen.coroutine
    def send_show_message(self, type, message):
        yield self.send_notification("window/showMessage", {"type": type, "message": message})
