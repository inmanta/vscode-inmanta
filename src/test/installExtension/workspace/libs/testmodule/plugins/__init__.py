from inmanta.plugins import plugin


@plugin()
def noop(message: "any"):
    """
    blablabla nononop

    :param message:a message
    :return: nothing
    """
    return message