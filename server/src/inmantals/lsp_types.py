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
from enum import Enum
from typing import List, Optional

from inmanta.data.model import BaseModel


class Position(BaseModel):
    """
    Position in a file. Based on the
    `LSP spec 3.15 <https://microsoft.github.io/language-server-protocol/specifications/specification-3-15/#position>`__
    """

    line: int
    character: int


class Range(BaseModel):
    """
    Range in a file. Based on the
    `LSP spec 3.15 <https://microsoft.github.io/language-server-protocol/specifications/specification-3-15/#range>`__
    """

    start: Position
    end: Position


class DiagnosticSeverity(Enum):
    """
    Diagnostic severity.
    `LSP spec 3.15 <https://microsoft.github.io/language-server-protocol/specifications/specification-3-15/#diagnostic>`__
    """

    Error: int = 1
    Warning: int = 2
    Information: int = 3
    Hint: int = 4


class MessageType(Enum):
    """
    Message type.
    `LSP spec 3.15 <https://microsoft.github.io/language-server-protocol/specifications/specification-3-15/#window_showMessage>`__
    """

    Error: int = 1
    Warning: int = 2
    Info: int = 3
    Debug: int = 4


class Diagnostic(BaseModel):
    """
    Diagnostic, such as a compiler error or warning. Based on the
    `LSP spec 3.15 <https://microsoft.github.io/language-server-protocol/specifications/specification-3-15/#diagnostic>`__.
    This type is more restrictive than the spec: it drops some optional fields.
    """

    range: Range
    severity: Optional[DiagnosticSeverity]
    message: str


class PublishDiagnosticsParams(BaseModel):
    """
    Parameters for the textDocument/publishDiagnostics method. Based on the
    `LSP spec 3.15
<https://microsoft.github.io/language-server-protocol/specifications/specification-3-15/#textDocument_publishDiagnostics>`__
    """

    uri: str
    diagnostics: List[Diagnostic]
