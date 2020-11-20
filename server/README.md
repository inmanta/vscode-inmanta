# Inmanta Language server

provides the bridge between the Inmanta compiler and Visual Studio Code ide, by implementing a Language Server

**This is alpha software, it may or may not work**

## Installation

1. mkvirtualenv -p python3 lstesting
2. pip install inmantals
3. install the inmanta extension via marketplace
4. change config for the extension (ctrl+,)

   1. set `inmanta.pythonPath` to the virtual env you just created `~/.virtualenvs/lstesting/bin/python3`
   2. set `inmanta.ls.enabled` to `true`

## Features

1. navigate-to-defintion on types

## Not supported yet

1. re-load code (not upon edit or upon save, need to close vscode)
2. work with incorrect models (needs to compile, all or nothing)

## Troubleshooting

### No module named x

If compilation fails with the message "no module named x" where x is a Python module, you might need to clean up the virtual
environments used by the compiler. This issue can be caused by running the compiler from multiple different environments.
To clean up the virtual environment, remove the .env directory in the Inmanta project directory as well as the compiler venv
specified by the client, if it exists.

## References

[https://microsoft.github.io/language-server-protocol/specification](https://microsoft.github.io/language-server-protocol/specification)
