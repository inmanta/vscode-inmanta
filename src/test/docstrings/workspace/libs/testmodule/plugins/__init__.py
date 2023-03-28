from inmanta.plugins import plugin


@plugin()
def noop(message: "any"):
    """
    returns the input

    :param message: a message as input
    """
    return message
