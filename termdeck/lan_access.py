import asyncio
import ipaddress
import json
import re
import shutil
import socket
import subprocess
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

import uvicorn
from starlette.types import ASGIApp, Receive, Scope, Send


@dataclass(frozen=True)
class LanInterface:
    name: str
    address: ipaddress.IPv4Address
    network: ipaddress.IPv4Network


class LanNetworkDiscovery:
    EXCLUDED_INTERFACE_PREFIXES = ("lo", "utun", "tun", "tap", "bridge", "docker", "veth", "awdl", "llw", "anpi")
    IPV4_PATTERN = re.compile(r"^\s*inet\s+(\d+(?:\.\d+){3})\s+netmask\s+(\S+)")
    INTERFACE_PATTERN = re.compile(r"^([A-Za-z0-9_.-]+):")
    IP_COMMAND_PATTERN = re.compile(r"^\d+:\s+([^\s:]+)(?:@\S+)?\s+inet\s+(\d+(?:\.\d+){3}/\d+)")

    @classmethod
    def discover(cls) -> tuple[LanInterface, ...]:
        interfaces = cls._discover_with_ifconfig()
        if not interfaces:
            interfaces = cls._discover_with_ip_command()
        if not interfaces:
            fallback = cls._discover_default_route_address()
            interfaces = (fallback,) if fallback is not None else ()
        unique = {(str(interface.address), str(interface.network)): interface for interface in interfaces}
        return tuple(sorted(unique.values(), key=lambda interface: (interface.name, int(interface.address))))

    @classmethod
    def _discover_with_ifconfig(cls) -> tuple[LanInterface, ...]:
        executable = shutil.which("ifconfig") or ("/sbin/ifconfig" if shutil.which("/sbin/ifconfig") else "")
        if not executable:
            return ()
        try:
            result = subprocess.run([executable], capture_output=True, text=True, timeout=3, check=False)
        except (OSError, subprocess.SubprocessError):
            return ()
        if result.returncode != 0:
            return ()
        current_interface = ""
        interfaces: list[LanInterface] = []
        for line in result.stdout.splitlines():
            interface_match = cls.INTERFACE_PATTERN.match(line)
            if interface_match:
                current_interface = interface_match.group(1)
                continue
            address_match = cls.IPV4_PATTERN.match(line)
            if not address_match or cls._excluded_interface(current_interface):
                continue
            interface = cls._interface_from_address_and_mask(current_interface, address_match.group(1), address_match.group(2))
            if interface is not None:
                interfaces.append(interface)
        return tuple(interfaces)

    @classmethod
    def _discover_with_ip_command(cls) -> tuple[LanInterface, ...]:
        executable = shutil.which("ip")
        if not executable:
            return ()
        try:
            result = subprocess.run([executable, "-o", "-4", "addr", "show", "up", "scope", "global"],
                                    capture_output=True, text=True, timeout=3, check=False)
        except (OSError, subprocess.SubprocessError):
            return ()
        if result.returncode != 0:
            return ()
        interfaces: list[LanInterface] = []
        for line in result.stdout.splitlines():
            match = cls.IP_COMMAND_PATTERN.match(line)
            if not match or cls._excluded_interface(match.group(1)):
                continue
            try:
                network_interface = ipaddress.IPv4Interface(match.group(2))
            except ipaddress.AddressValueError:
                continue
            if cls._usable_address(network_interface.ip):
                interfaces.append(LanInterface(match.group(1), network_interface.ip, network_interface.network))
        return tuple(interfaces)

    @classmethod
    def _discover_default_route_address(cls) -> LanInterface | None:
        udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            udp_socket.connect(("192.0.2.1", 9))
            address = ipaddress.IPv4Address(udp_socket.getsockname()[0])
        except (OSError, ipaddress.AddressValueError):
            return None
        finally:
            udp_socket.close()
        if not cls._usable_address(address):
            return None
        return LanInterface("default", address, ipaddress.IPv4Network(f"{address}/24", strict=False))

    @classmethod
    def _interface_from_address_and_mask(cls, name: str, address_text: str, mask_text: str) -> LanInterface | None:
        try:
            address = ipaddress.IPv4Address(address_text)
            mask = str(ipaddress.IPv4Address(int(mask_text, 16))) if mask_text.lower().startswith("0x") else mask_text
            network = ipaddress.IPv4Network(f"{address}/{mask}", strict=False)
        except (ipaddress.AddressValueError, ipaddress.NetmaskValueError, ValueError):
            return None
        return LanInterface(name, address, network) if cls._usable_address(address) else None

    @classmethod
    def _excluded_interface(cls, name: str) -> bool:
        normalized = name.casefold()
        return not normalized or normalized.startswith(cls.EXCLUDED_INTERFACE_PREFIXES)

    @staticmethod
    def _usable_address(address: ipaddress.IPv4Address) -> bool:
        return address.is_private and not address.is_loopback and not address.is_link_local and not address.is_unspecified


class LanAccessPolicy:
    REFRESH_INTERVAL_SECONDS = 5.0

    def __init__(self) -> None:
        self.interfaces: tuple[LanInterface, ...] = ()
        self.last_refresh_at = 0.0

    def refresh(self, force: bool = False) -> tuple[LanInterface, ...]:
        now = time.monotonic()
        if force or now - self.last_refresh_at >= self.REFRESH_INTERVAL_SECONDS:
            self.interfaces = LanNetworkDiscovery.discover()
            self.last_refresh_at = now
        return self.interfaces

    def allows(self, client_host: str) -> bool:
        try:
            address = ipaddress.ip_address(client_host.split("%", 1)[0])
        except ValueError:
            return False
        if address.is_loopback:
            return True
        return isinstance(address, ipaddress.IPv4Address) and any(address in interface.network for interface in self.interfaces)

    def urls(self, port: int) -> list[str]:
        return [f"http://{interface.address}:{port}" for interface in self.interfaces]

    def networks(self) -> list[str]:
        return [f"{interface.name} · {interface.network}" for interface in self.interfaces]


class LanOnlyApplication:
    def __init__(self, application: ASGIApp, policy: LanAccessPolicy) -> None:
        self.application = application
        self.policy = policy

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.application(scope, receive, send)
            return
        client = scope.get("client")
        client_host = str(client[0]) if client else ""
        if not self.policy.allows(client_host):
            await asyncio.to_thread(self.policy.refresh)
        if self.policy.allows(client_host):
            await self.application(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4403, "reason": "local network access only"})
            return
        body = json.dumps({"detail": "local network access only"}).encode()
        await send({"type": "http.response.start", "status": 403,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


class LanUvicornServer(uvicorn.Server):
    @contextmanager
    def capture_signals(self) -> Iterator[None]:
        yield


class LanAccessManager:
    START_TIMEOUT_SECONDS = 4.0
    STOP_TIMEOUT_SECONDS = 5.0

    def __init__(self, application: ASGIApp, port: int, log_level: str) -> None:
        self.port = port
        self.log_level = log_level
        self.policy = LanAccessPolicy()
        self.application = LanOnlyApplication(application, self.policy)
        self.server: LanUvicornServer | None = None
        self.server_task: asyncio.Task[None] | None = None
        self.listen_socket: socket.socket | None = None
        self.operation_lock = asyncio.Lock()
        self.last_error = ""

    async def start(self) -> None:
        async with self.operation_lock:
            if self.server_task is not None and not self.server_task.done():
                return
            interfaces = await asyncio.to_thread(self.policy.refresh, True)
            if not interfaces:
                raise RuntimeError("no active private local network was found")
            listen_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listen_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                listen_socket.bind(("0.0.0.0", self.port))
                listen_socket.listen(socket.SOMAXCONN)
                listen_socket.setblocking(False)
            except OSError:
                listen_socket.close()
                raise
            config = uvicorn.Config(self.application, host="0.0.0.0", port=self.port, log_level=self.log_level,
                                    access_log=False, lifespan="off")
            self.listen_socket = listen_socket
            self.server = LanUvicornServer(config)
            self.server_task = asyncio.create_task(self.server.serve(sockets=[listen_socket]))
            deadline = asyncio.get_running_loop().time() + self.START_TIMEOUT_SECONDS
            while not self.server.started and asyncio.get_running_loop().time() < deadline:
                if self.server_task.done():
                    await self.server_task
                    raise RuntimeError("local network listener stopped during startup")
                await asyncio.sleep(0.02)
            if not self.server.started:
                await self._stop_locked()
                raise RuntimeError("local network listener did not start")
            self.last_error = ""

    async def stop(self) -> None:
        async with self.operation_lock:
            await self._stop_locked()

    async def _stop_locked(self) -> None:
        server = self.server
        task = self.server_task
        if server is not None:
            server.should_exit = True
        if task is not None and not task.done():
            try:
                await asyncio.wait_for(task, timeout=self.STOP_TIMEOUT_SECONDS)
            except TimeoutError:
                if server is not None:
                    server.force_exit = True
                await task
        listen_socket = self.listen_socket
        if listen_socket is not None and listen_socket.fileno() >= 0:
            listen_socket.close()
        self.server = None
        self.server_task = None
        self.listen_socket = None

    def record_error(self, error: OSError | RuntimeError) -> None:
        self.last_error = str(error)

    async def status(self, enabled: bool) -> dict[str, object]:
        await asyncio.to_thread(self.policy.refresh, True)
        running = self.server is not None and self.server.started and self.server_task is not None and not self.server_task.done()
        return {"enabled": enabled, "running": running, "port": self.port, "urls": self.policy.urls(self.port),
                "networks": self.policy.networks(), "error": self.last_error}
