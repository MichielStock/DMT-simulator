"""Loopback-only socket guard (BUILD.md §4.6)."""
import socket
import threading

import pytest

from backend.safety import socket_guard


def test_blocks_public_and_allows_loopback():
    socket_guard.install()
    socket_guard.install()  # idempotent
    assert socket_guard.installed()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1)
    with pytest.raises(socket_guard.NetworkBlocked):
        s.connect(("1.1.1.1", 80))
    with pytest.raises(OSError):
        s.connect_ex(("1.1.1.1", 80))
    s.close()
    with pytest.raises(OSError):
        socket.create_connection(("1.1.1.1", 80), timeout=1)
    with pytest.raises(OSError):
        socket.create_connection(("example.com", 80), timeout=1)

    # loopback works: a tiny local server
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    t = threading.Thread(target=lambda: srv.accept()[0].close(), daemon=True)
    t.start()
    c = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    c.settimeout(2)
    c.connect(("127.0.0.1", port))
    c.close()
    t.join(2)
    srv.close()


def test_is_loopback():
    for h in ("127.0.0.1", "127.5.6.7", "::1", "localhost", "::ffff:127.0.0.1"):
        assert socket_guard.is_loopback(h), h
    for h in ("1.1.1.1", "10.0.0.1", "192.168.1.1", "8.8.8.8", "2606:4700::1111"):
        assert not socket_guard.is_loopback(h), h


def test_unix_socket_allowed(tmp_path):
    socket_guard.install()
    path = str(tmp_path / "s.sock")
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    srv.listen(1)
    c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    c.connect(path)
    c.close()
    srv.close()


def test_httpx_blocked():
    import httpx

    socket_guard.install()
    with pytest.raises(Exception):
        httpx.get("http://1.1.1.1/", timeout=2)
