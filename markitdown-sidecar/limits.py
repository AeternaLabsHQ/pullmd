"""Run untrusted parsing work in a short-lived child process with a wall-clock
timeout and an optional address-space (memory) cap.

The markitdown converter parses attacker-supplied documents (PDF/Office/EPUB/ZIP
…). A decompression bomb or a pathological file can otherwise pin CPU or balloon
memory inside the long-lived uvicorn process. Running each conversion in a
disposable child means:

  * a wall-clock overrun is killed by the parent (TimeoutError),
  * an out-of-memory child dies without taking uvicorn down,
  * an optional RLIMIT_AS cap bounds per-conversion memory.

RLIMIT_AS counts virtual address space (which can over-count for threaded /
mmap-heavy processes), so the memory cap is opt-in; the timeout + process
isolation are the always-on protections. A container-level mem_limit is the
recommended hard memory bound.
"""
import multiprocessing as mp


def _child(conn, target, args, mem_bytes):
    try:
        if mem_bytes and mem_bytes > 0:
            import resource
            try:
                resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))
            except (ValueError, OSError):
                pass
        conn.send(("ok", target(*args)))
    except BaseException as e:  # noqa: BLE001 - MemoryError, parser failures, etc.
        try:
            conn.send(("err", repr(e)[:300]))
        except Exception:
            pass
    finally:
        conn.close()


def _context():
    # Use 'spawn': a fresh interpreter that inherits none of the parent's
    # threads or held locks. The conversion is launched from a uvicorn
    # threadpool thread, and markitdown does lazy imports while parsing, so a
    # 'fork' here could deadlock the child on an import/alloc lock held by
    # another thread at fork time. The cost is re-importing the target module
    # per conversion, acceptable for this low-QPS document path.
    methods = mp.get_all_start_methods()
    return mp.get_context("spawn" if "spawn" in methods else "fork")


def run_guarded(target, args=(), *, timeout=60.0, mem_mb=0):
    """Run ``target(*args)`` in a child process and return its result.

    Raises:
        TimeoutError: the work exceeded ``timeout`` seconds (child is killed).
        MemoryError: the child died before returning (typically the memory cap).
        RuntimeError: the target raised; the message carries the repr.
    """
    ctx = _context()
    recv_conn, send_conn = ctx.Pipe(duplex=False)
    proc = ctx.Process(
        target=_child,
        args=(send_conn, target, tuple(args), int(mem_mb) * 1024 * 1024),
        daemon=True,
    )
    proc.start()
    send_conn.close()  # parent keeps only the receiving end

    wait = timeout if (timeout and timeout > 0) else None
    if not recv_conn.poll(wait):
        proc.terminate()
        proc.join(2)
        if proc.is_alive():
            proc.kill()
            proc.join()
        raise TimeoutError(f"work exceeded {timeout}s")

    try:
        status, payload = recv_conn.recv()
    except EOFError:
        raise MemoryError("worker died before returning (resource limit exceeded)")
    finally:
        proc.join(2)
        if proc.is_alive():
            proc.terminate()

    if status == "err":
        raise RuntimeError(payload)
    return payload
