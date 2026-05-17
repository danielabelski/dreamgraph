"""basic.py — Python extractor fixture (PY-1..PY-3)."""
from __future__ import annotations

import os
import json as j
from typing import Dict, List, Optional, Protocol, Union
from .legacy import *
from ..pkg import helper as h
from dataclasses import dataclass
from abc import ABC, abstractmethod
from enum import Enum

MAX_USERS: int = 100
DEFAULT_NAME = "anon"


@dataclass
class User:
    """A user record."""

    id: int
    name: str
    email: Optional[str] = None
    aliases: List[str] = None
    tags: Dict[str, int] = None
    pipe_optional: str | None = None


class Repository(Protocol):
    """Structural typing surface for a user repository."""

    def find_all(self) -> List[User]: ...


class UserRepository(Repository):
    """Concrete user repository."""

    users: List[User]
    cache: Dict[int, User]
    maybe: Optional[User] = None

    def __init__(self, seed: List[User]) -> None:
        self.users = seed
        self.cache = {}
        self.private_counter = 0

    @classmethod
    def empty(cls) -> "UserRepository":
        return cls([])

    @staticmethod
    def version() -> str:
        return "1.0"

    @property
    def size(self) -> int:
        return len(self.users)

    async def fetch(self, id: int) -> Optional[User]:
        return self.cache.get(id)


class AbstractGateway(ABC):
    @abstractmethod
    def send(self, payload: Dict[str, str]) -> None: ...


class Status(Enum):
    ACTIVE = "active"
    INACTIVE = "inactive"


def top_level_helper(x: int) -> int:
    return x + 1


async def async_helper() -> None:
    pass
