"""
    Copyright 2020 Inmanta

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
"""
    This module contains types as specified in the
    `LSP spec 3.15 <https://microsoft.github.io/language-server-protocol/specifications/specification-3-15/>`__
"""
from enum import Enum
from typing import List, Optional, Union

from inmanta.data.model import BaseModel


# Data types

class Position(BaseModel):
    """
    Position in a file.
    """

    line: int
    character: int


class Range(BaseModel):
    """
    Range in a file.
    """

    start: Position
    end: Position


class Location(BaseModel):
    """
    Location: file and range within that file.
    """

    uri: str
    range: Range


class DiagnosticSeverity(Enum):
    Error: int = 1
    Warning: int = 2
    Information: int = 3
    Hint: int = 4


class Diagnostic(BaseModel):
    """
    Diagnostic, such as a compiler error or warning. This type is more restrictive than the spec: it drops some optional fields.
    """

    range: Range
    severity: Optional[DiagnosticSeverity]
    message: str


class SymbolKind(Enum):

    # supported by default
    File: int = 1
    Module: int = 2
    Namespace: int = 3
    Package: int = 4
    Class: int = 5
    Method: int = 6
    Property: int = 7
    Field: int = 8
    Constructor: int = 9
    Enum: int = 10
    Interface: int = 11
    Function: int = 12
    Variable: int = 13
    Constant: int = 14
    String: int = 15
    Number: int = 16
    Boolean: int = 17
    Array: int = 18

    # only supported if explicitly included in client capabilities
    Object: int = 19
    Key: int = 20
    Null: int = 21
    EnumMember: int = 22
    Struct: int = 23
    Event: int = 24
    Operator: int = 25
    TypeParameter: int = 26


class SymbolInformation(BaseModel):
    """
    Information about language constructs like variables, entities etc.
    """

    name: str
    kind: SymbolKind
    deprecated: Optional[bool]
    location: Location
    containerName: Optional[str]


# Message parameters

class PublishDiagnosticsParams(BaseModel):
    """
    Parameters for the textDocument/publishDiagnostics method.
    """

    uri: str
    diagnostics: List[Diagnostic]


ProgressToken = Union[int, str]


class WorkDoneProgressParams(BaseModel):
    """
    Parameters related to work done progress.
    """

    workDoneToken: Optional[ProgressToken]


class PartialResultParams(BaseModel):
    """
    Parameters related to partial result progress.
    """

    partialResultToken: Optional[ProgressToken]


class WorkspaceSymbolParams(WorkDoneProgressParams, PartialResultParams):
    """
    Parameters for the workspace/symbol method.
    """

    query: str
