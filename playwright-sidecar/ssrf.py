"""Outbound address policy for the Playwright sidecar.

Port of ``lib/ssrf.js``: the same block ranges, the same transition-address
embeddings and the same ``PULLMD_ALLOWED_HOSTS`` grammar, so a target that
Node refuses is refused here too. Node checks the submitted URL once; this
module is what Chromium's own navigations (redirects, meta refresh, JavaScript
``location`` changes, iframes, subresources) are checked against, because none
of those pass through Node (GHSA-26wr-prg5-vr77).

Pure functions plus one async entry point with an injectable resolver, so the
tests run without Playwright.
"""
from __future__ import annotations

import ipaddress
from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit

IPNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network

# Reported in /health so pullmd can tell this sidecar from one that predates
# the policy: an old image ignores allowedHosts and fetches whatever Chromium
# asks for. The number is the policy revision; bump it when pullmd should
# start requiring a newer one (lib/status.js holds the minimum).
POLICY = {"ssrf": 1}

# IPv4 ranges that must never be reached via user-supplied URLs.
# 100.64.0.0/10 (CGNAT/shared) covers Alibaba metadata 100.100.100.200.
# 169.254.0.0/16 (link-local) covers cloud metadata 169.254.169.254.
BLOCKED_V4 = [
    ("0.0.0.0", 8), ("10.0.0.0", 8), ("100.64.0.0", 10), ("127.0.0.0", 8),
    ("169.254.0.0", 16), ("172.16.0.0", 12), ("192.0.0.0", 24), ("192.0.2.0", 24),
    ("192.168.0.0", 16), ("198.18.0.0", 15), ("198.51.100.0", 24), ("203.0.113.0", 24),
    ("224.0.0.0", 4), ("240.0.0.0", 4), ("255.255.255.255", 32),
]

# IPv6 ranges. fc00::/7 (unique-local) covers AWS metadata fd00:ec2::254.
BLOCKED_V6 = [
    ("::1", 128), ("::", 128), ("fc00::", 7), ("fe80::", 10), ("ff00::", 8), ("2001:db8::", 32),
]


class PolicyError(Exception):
    """The URL must not be fetched. ``str(err)`` is the operator-facing reason."""


def _build_blocklist() -> list[IPNetwork]:
    nets: list[IPNetwork] = []
    for addr, prefix in BLOCKED_V4:
        nets.append(ipaddress.ip_network(f"{addr}/{prefix}", strict=False))
    for addr, prefix in BLOCKED_V6:
        nets.append(ipaddress.ip_network(f"{addr}/{prefix}", strict=False))

    # Blocked v4 ranges reached via IPv6 transition addressing (NAT64, 6to4,
    # IPv4-compatible). Per blocked v4 subnet add the matching embedded v6
    # subnet, so a NAT64 host still resolves legit public v4 while
    # metadata/private v4 stays blocked in every form. Same construction as
    # buildBlockList() in lib/ssrf.js.
    for addr, prefix in BLOCKED_V4:
        a, b, c, d = (int(x) for x in addr.split("."))
        hi = f"{(a << 8) | b:x}"
        lo = f"{(c << 8) | d:x}"
        # NAT64 well-known prefix 64:ff9b::/96 - v4 in the low 32 bits
        nets.append(ipaddress.ip_network(f"64:ff9b::{hi}:{lo}/{96 + prefix}", strict=False))
        # IPv4-compatible ::/96 (deprecated) - v4 in the low 32 bits
        nets.append(ipaddress.ip_network(f"::{hi}:{lo}/{96 + prefix}", strict=False))
        # 6to4 2002::/16 - v4 in bits 16-48
        nets.append(ipaddress.ip_network(f"2002:{hi}:{lo}::/{16 + prefix}", strict=False))
    return nets


_BLOCKLIST = _build_blocklist()


def _parse_ip(value: str):
    """Parse an address literal; IPv4-mapped IPv6 collapses to its IPv4."""
    text = value.strip()
    if "%" in text:  # zone id (fe80::1%eth0) is not part of the address
        text = text.split("%", 1)[0]
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        return None
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    return ip


def is_blocked_ip(value: str) -> bool:
    ip = _parse_ip(value)
    if ip is None:
        return True  # not a parseable IP -> treat as unsafe
    return any(ip in net for net in _BLOCKLIST)


class AllowList:
    """Parsed ``PULLMD_ALLOWED_HOSTS``: CIDRs, bare IPs and exact hostnames."""

    def __init__(self, value: str | None):
        self.networks: list[IPNetwork] = []
        self.hostnames: set[str] = set()
        for raw in (value or "").split(","):
            entry = raw.strip()
            if not entry:
                continue
            if "/" in entry:
                addr, _, prefix = entry.partition("/")
                if _parse_ip(addr) is None or not prefix.isdigit():
                    continue
                try:
                    self.networks.append(ipaddress.ip_network(f"{addr}/{int(prefix)}", strict=False))
                except ValueError:
                    continue
            elif _parse_ip(entry) is not None:
                self.networks.append(ipaddress.ip_network(entry, strict=False))
            else:
                self.hostnames.add(entry.lower())

    def allows_host(self, host: str) -> bool:
        return host.lower() in self.hostnames

    def allows_ip(self, value: str) -> bool:
        ip = _parse_ip(value)
        if ip is None:
            return False
        return any(ip in net for net in self.networks)


# Schemes that never touch the network: let Chromium handle them.
_LOCAL_SCHEMES = {"data", "blob", "about"}


def url_target(url: str) -> tuple[str, str | None]:
    """Return ``(scheme, host)``. ``host`` is None for local-only schemes.

    Raises PolicyError for anything that is neither http(s) nor local.
    """
    try:
        parts = urlsplit(url)
    except ValueError as exc:
        raise PolicyError(f"invalid URL: {url[:80]}") from exc
    scheme = (parts.scheme or "").lower()
    if scheme in _LOCAL_SCHEMES:
        return scheme, None
    if scheme not in ("http", "https"):
        raise PolicyError(f"scheme not allowed: {scheme or '(none)'}:")
    host = parts.hostname  # already lower-cased and bracket-stripped
    if not host:
        raise PolicyError(f"invalid URL: {url[:80]}")
    return scheme, host


def check_addresses(host: str, addresses: list[str], allow: AllowList) -> None:
    """Raise PolicyError when any address of ``host`` is in a blocked range."""
    if not addresses:
        raise PolicyError(f"host did not resolve: {host}")
    for ip in addresses:
        if allow.allows_ip(ip):
            continue
        if is_blocked_ip(ip):
            raise PolicyError(f"blocked address {ip} for host {host}")


Resolver = Callable[[str], Awaitable[list[str]]]


async def assert_url_allowed(
    url: str,
    allow: AllowList,
    resolver: Resolver,
    cache: dict[str, list[str]] | None = None,
) -> None:
    """Raise PolicyError unless every address ``url`` can reach is permitted.

    ``cache`` memoises resolutions per render so a page with hundreds of
    subresources from one host costs one lookup. A failed lookup is a block:
    a name that cannot be resolved cannot be a legitimate target either.
    """
    _, host = url_target(url)
    if host is None:
        return
    if allow.allows_host(host):
        return
    if _parse_ip(host) is not None:
        addresses = [host]
    else:
        addresses = cache.get(host) if cache is not None else None
        if addresses is None:
            try:
                addresses = await resolver(host)
            except Exception as exc:  # noqa: BLE001 - any resolver failure is a block
                raise PolicyError(f"could not resolve host: {host}") from exc
            if cache is not None:
                cache[host] = addresses
    check_addresses(host, addresses, allow)
