import sys
# from inmanta.lsp.server import InmantaPly
# import socketserver
# import logging
from inmanta.lsp.jsonrpc import JsonRpcServer, JsonRpcHandler
from tornado import ioloop
from tornado.ioloop import IOLoop
from inmanta.lsp.server import InmantaPly
import logging
#
# log = logging.getLogger(__name__)
#
#
# class _StreamHandlerWrapper(socketserver.StreamRequestHandler, object):
#     """A wrapper class that is used to construct a custom handler class."""
#
#     delegate = None
#
#     def setup(self):
#         super(_StreamHandlerWrapper, self).setup()
#         # pylint: disable=no-member
#         self.delegate = self.DELEGATE_CLASS(self.rfile, self.wfile)
#
#     def handle(self):
#         self.delegate.handle()
#
#
# def start_tcp_lang_server(bind_addr, port, handler_class):
#     # Construct a custom wrapper class around the user's handler_class
#     wrapper_class = type(
#         handler_class.__name__ + "Handler",
#         (_StreamHandlerWrapper,),
#         {'DELEGATE_CLASS': handler_class}
#     )
#
#     server = socketserver.ThreadingTCPServer((bind_addr, port), wrapper_class)
#     try:
#         log.info("Serving %s on (%s, %s)", handler_class.__name__, bind_addr, port)
#         server.serve_forever()
#     finally:
#         log.info("Shutting down")
#         server.server_close()


def main():
    #start_tcp_lang_server("0.0.0.0", 5432, InmantaPly)
    logging.basicConfig(level=logging.DEBUG)
    server = JsonRpcServer(IOLoop.current(), InmantaPly)
    server.listen(5432)
    IOLoop.current().start()


if __name__ == "__main__":
    main()
