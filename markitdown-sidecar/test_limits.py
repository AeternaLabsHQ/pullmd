"""Standalone tests for the resource-guard harness (limits.run_guarded).

No pytest / markitdown dependency — run directly:  python3 test_limits.py
Exits non-zero on the first failed assertion.
"""
import time

from limits import run_guarded


# Module-level targets so they are picklable under the 'spawn' start method too.
def _double(x):
    return x * 2


def _sleep_forever():
    time.sleep(30)
    return "done"


def _eat_memory():
    # Allocate far beyond the cap; should be killed by RLIMIT_AS.
    chunks = []
    for _ in range(4096):
        chunks.append(bytearray(64 * 1024 * 1024))  # 64 MB each
    return len(chunks)


def _boom():
    raise ValueError("explode")


def test_returns_value():
    assert run_guarded(_double, (21,), timeout=10, mem_mb=512) == 42


def test_timeout_kills_slow_work():
    t0 = time.time()
    try:
        run_guarded(_sleep_forever, (), timeout=1, mem_mb=512)
        raise AssertionError("expected TimeoutError")
    except TimeoutError:
        pass
    assert time.time() - t0 < 5, "must return shortly after the timeout, not run to completion"


def test_memory_cap_kills_bomb():
    try:
        run_guarded(_eat_memory, (), timeout=20, mem_mb=128)
        raise AssertionError("expected the over-allocating worker to be killed")
    except (MemoryError, RuntimeError):
        pass


def test_worker_exception_propagates():
    try:
        run_guarded(_boom, (), timeout=10, mem_mb=512)
        raise AssertionError("expected RuntimeError")
    except RuntimeError as e:
        assert "explode" in str(e)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok - {t.__name__}")
    print(f"\n{len(tests)} passed")
