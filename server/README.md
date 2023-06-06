# Inmanta Language server

Provides the bridge between the Inmanta compiler and Visual Studio Code IDE, by implementing a Language Server.

For recent versions of `inmanta-core` (`>=6`), the server takes ownership of the Python environment it runs in and installs any
modules and module dependencies in that environment. For older versions of `inmanta-core`, a separate compiler venv is used,
which can be configured with the `compilerVenv` option.

**This is alpha software, it may or may not work**

## Installation

1. mkvirtualenv -p python3 lstesting
2. pip install inmantals
3. install the inmanta extension via marketplace
4. change config for the extension (ctrl+,)

   1. set `inmanta.pythonPath` to the virtual env you just created `~/.virtualenvs/lstesting/bin/python3`
   2. set `inmanta.ls.enabled` to `true`

## Features

1. navigate-to-definition on types
2. docstring display on hover
3. find references to a symbol (e.g. right-click > Find All References)
4. supports working on an Inmanta project or an Inmanta module

## Not supported yet

1. work with incorrect models (needs to compile, all or nothing)

## Troubleshooting

### No module named x

If compilation fails with the message "no module named x" where x is a Python module, you might need to clean up the virtual
environments used by the compiler. This issue can be caused by running the compiler from multiple different environments.
To clean up the virtual environment, remove the .env directory in the Inmanta project directory as well as the compiler venv
specified by the client, if it exists.

## References

[https://microsoft.github.io/language-server-protocol/specification](https://microsoft.github.io/language-server-protocol/specification)
