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

## References

[https://microsoft.github.io/language-server-protocol/specification](https://microsoft.github.io/language-server-protocol/specification)