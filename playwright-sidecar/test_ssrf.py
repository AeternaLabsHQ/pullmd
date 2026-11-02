"""Standalone tests for the sidecar address policy (mirror of test/ssrf.test.js).

No pytest / playwright dependency — run directly:  python3 test_ssrf.py
Exits non-zero on the first failed assertion.
"""
import asyncio

from ssrf import POLICY, AllowList, PolicyError, assert_url_allowed, is_blocked_ip, url_target


def run(coro):
    return asyncio.run(coro)


def resolver_for(table):
    async def resolve(host):
        if host not in table:
            raise OSError("NXDOMAIN")
        return list(table[host])
    return resolve


def raises(coro):
    try:
        run(coro)
    except PolicyError as exc:
        return str(exc)
    raise AssertionError("expected PolicyError")


def test_blocked_ranges_match_node():
    for ip in ("127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
               "169.254.169.254", "100.100.100.200", "0.0.0.0", "224.0.0.1", "255.255.255.255",
               "198.18.0.1", "192.0.0.1", "198.51.100.7", "203.0.113.9"):
        assert is_blocked_ip(ip), ip
    for ip in ("8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "93.184.216.34"):
        assert not is_blocked_ip(ip), ip


def test_blocked_v6_and_transition_addresses():
    for ip in ("::1", "::", "fd00:ec2::254", "fe80::1", "fe80::1%eth0", "ff02::1", "2001:db8::1",
               "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::7f00:1",
               "64:ff9b::a9fe:a9fe", "64:ff9b::169.254.169.254", "::a9fe:a9fe", "2002:7f00:1::1", "2002:a9fe:a9fe::1"):
        assert is_blocked_ip(ip), ip
    for ip in ("2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"):
        assert not is_blocked_ip(ip), ip


def test_unparseable_is_blocked():
    assert is_blocked_ip("not-an-ip")
    assert is_blocked_ip("")


def test_url_target_schemes():
    assert url_target("https://Example.COM:8443/x") == ("https", "example.com")
    assert url_target("http://[::1]/") == ("http", "::1")
    assert url_target("data:text/html,hi") == ("data", None)
    assert url_target("about:blank") == ("about", None)
    assert url_target("blob:https://example.com/uuid") == ("blob", None)
    for bad in ("file:///etc/passwd", "ftp://example.com/", "chrome://version", "javascript:alert(1)", "http:///nohost"):
        try:
            url_target(bad)
        except PolicyError:
            continue
        raise AssertionError(f"expected PolicyError for {bad}")


def test_literal_internal_hosts_blocked_without_resolver():
    allow = AllowList(None)
    resolve = resolver_for({})
    assert "blocked address 169.254.169.254" in raises(assert_url_allowed("http://169.254.169.254/latest/", allow, resolve))
    assert "blocked address 127.0.0.1" in raises(assert_url_allowed("http://127.0.0.1:9000/", allow, resolve))
    assert "blocked address ::1" in raises(assert_url_allowed("http://[::1]:9000/", allow, resolve))
    assert "blocked address ::ffff:10.0.0.1" in raises(assert_url_allowed("http://[::ffff:10.0.0.1]/", allow, resolve))


def test_resolved_internal_host_blocked_public_allowed():
    allow = AllowList(None)
    resolve = resolver_for({"internal-secret": ["172.20.0.4"], "example.com": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]})
    assert "blocked address 172.20.0.4 for host internal-secret" in raises(
        assert_url_allowed("http://internal-secret:9000/", allow, resolve))
    run(assert_url_allowed("https://example.com/page", allow, resolve))  # no raise


def test_mixed_resolution_blocked_if_any_address_internal():
    allow = AllowList(None)
    resolve = resolver_for({"evil.example": ["93.184.216.34", "10.0.0.5"]})
    assert "blocked address 10.0.0.5" in raises(assert_url_allowed("http://evil.example/", allow, resolve))


def test_resolution_failure_blocks():
    allow = AllowList(None)
    assert "could not resolve host: nope.invalid" in raises(assert_url_allowed("http://nope.invalid/", allow, resolver_for({})))
    assert "host did not resolve: empty.example" in raises(
        assert_url_allowed("http://empty.example/", allow, resolver_for({"empty.example": []})))


def test_local_schemes_pass_without_lookup():
    allow = AllowList(None)
    run(assert_url_allowed("data:text/html,<p>x</p>", allow, resolver_for({})))
    run(assert_url_allowed("about:blank", allow, resolver_for({})))


def test_allowlist_hostname_cidr_and_ip():
    allow = AllowList("10.0.5.0/24, wiki.internal ,192.168.1.7,fd00::/8")
    resolve = resolver_for({"wiki.internal": ["10.9.9.9"], "docs.internal": ["10.0.5.20"],
                            "other.internal": ["10.0.6.1"], "v6.internal": ["fd12::1"]})
    run(assert_url_allowed("http://wiki.internal/", allow, resolve))     # hostname match, no lookup needed
    run(assert_url_allowed("http://docs.internal/", allow, resolve))     # CIDR match
    run(assert_url_allowed("http://192.168.1.7/", allow, resolve))       # bare IP match
    run(assert_url_allowed("http://v6.internal/", allow, resolve))       # v6 CIDR match
    assert "blocked address 10.0.6.1" in raises(assert_url_allowed("http://other.internal/", allow, resolve))
    assert "blocked address 192.168.1.8" in raises(assert_url_allowed("http://192.168.1.8/", allow, resolve))


def test_allowlist_ignores_garbage_entries():
    allow = AllowList("not/a/cidr,10.0.0.0/99,,  ")
    assert allow.networks == []
    assert allow.hostnames == set()
    assert "blocked address 10.0.0.1" in raises(assert_url_allowed("http://10.0.0.1/", allow, resolver_for({})))


def test_cache_memoises_lookups():
    allow = AllowList(None)
    calls = []

    async def resolve(host):
        calls.append(host)
        return ["93.184.216.34"]

    cache = {}
    run(assert_url_allowed("https://example.com/a", allow, resolve, cache))
    run(assert_url_allowed("https://example.com/b", allow, resolve, cache))
    run(assert_url_allowed("https://example.com:8443/c", allow, resolve, cache))
    assert calls == ["example.com"], calls


def test_policy_marker_is_a_positive_revision():
    # lib/status.js reads policy.ssrf and requires an integer >= 1.
    assert isinstance(POLICY["ssrf"], int) and not isinstance(POLICY["ssrf"], bool)
    assert POLICY["ssrf"] >= 1


def test_health_reports_the_policy_marker():
    # app.py needs Playwright to import, so check the handler's source instead:
    # /health must return the marker whether or not the browser is up.
    import ast
    from pathlib import Path

    tree = ast.parse((Path(__file__).parent / "app.py").read_text())
    health = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "health")
    returned = next(n.value for n in ast.walk(health) if isinstance(n, ast.Return))
    assert isinstance(returned, ast.Dict)
    keys = {k.value: v for k, v in zip(returned.keys, returned.values)}
    assert isinstance(keys.get("policy"), ast.Name) and keys["policy"].id == "POLICY", keys


if __name__ == "__main__":
    import sys
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as exc:
                failed += 1
                print(f"FAIL {name}: {exc}")
    sys.exit(1 if failed else 0)
