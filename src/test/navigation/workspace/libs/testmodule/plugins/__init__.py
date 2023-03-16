from inmanta.plugins import plugin


@plugin()
def noop(message: "any"):
    return message
