"""Loopback-only socket guard (BUILD.md §4.6).

`install()` monkeypatches `socket.socket.connect`, `connect_ex` and `socket.create_connection`
so that any outbound connection to a non-loopback address raises `NetworkBlocked`.
Allowed: 127.0.0.0/8, ::1 (and IPv4-mapped loopback), and unix-domain sockets.
Host names are never resolved: only `localhost` names are allowed.
`install()` is idempotent.
"""
from __future__ import annotations

import ipaddress
import socket
import threading

__all__ = ["install", "uninstall", "installed", "NetworkBlocked", "is_loopback"]


class NetworkBlocked(ConnectionRefusedError):
    """Raised when code tries to reach a non-loopback address."""


_lock = threading.Lock()
_orig: dict = {}


def is_loopback(host) -> bool:
    if host is None:
        return False
    if isinstance(host, (bytes, bytearray)):
        host = host.decode("ascii", "ignore")
    host = str(host).strip("[]")
    if host == "" or host.lower() == "localhost":
        return True
    host = host.split("%", 1)[0]  # strip IPv6 zone id
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # A host name: only localhost names are accepted; never resolve other names (no DNS lookups offline).
        h = host.lower().rstrip(".")
        return h == "localhost" or h.endswith(".localhost") or h in ("ip6-localhost", "ip6-loopback")
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback


def _check(sock, address):
    family = getattr(sock, "family", None)
    if family == getattr(socket, "AF_UNIX", object()):
        return
    if isinstance(address, (str, bytes)) and family is None:
        return
    host = address[0] if isinstance(address, tuple) else address
    if not is_loopback(host):
        raise NetworkBlocked(f"Hyperspace runs offline: outbound connection to {host!r} refused by the socket guard")


def _connect(self, address):
    _check(self, address)
    return _orig["connect"](self, address)


def _connect_ex(self, address):
    _check(self, address)
    return _orig["connect_ex"](self, address)


def _create_connection(address, *args, **kwargs):
    host = address[0]
    if not is_loopback(host):
        raise NetworkBlocked(f"Hyperspace runs offline: outbound connection to {host!r} refused by the socket guard")
    return _orig["create_connection"](address, *args, **kwargs)


def install() -> None:
    with _lock:
        if _orig:
            return
        _orig["connect"] = socket.socket.connect
        _orig["connect_ex"] = socket.socket.connect_ex
        _orig["create_connection"] = socket.create_connection
        _orig["getaddrinfo"] = socket.getaddrinfo
        socket.socket.connect = _connect
        socket.socket.connect_ex = _connect_ex
        socket.create_connection = _create_connection


def uninstall() -> None:
    """Only for tests."""
    with _lock:
        if not _orig:
            return
        socket.socket.connect = _orig["connect"]
        socket.socket.connect_ex = _orig["connect_ex"]
        socket.create_connection = _orig["create_connection"]
        _orig.clear()


def installed() -> bool:
    return bool(_orig)
