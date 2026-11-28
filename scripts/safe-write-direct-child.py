#!/usr/bin/env python3
"""Atomically write one file inside a verified direct-child directory.

The parent may contain entries controlled by an untrusted tenant.  All
filesystem operations below are therefore anchored to already-open directory
descriptors.  A symlink/hardlink at the destination is replaced as a directory
entry and is never followed; swapping the child directory after it is opened
cannot redirect the write outside the opened inode.
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import secrets
import stat
import sys


DIR_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_CLOEXEC", 0)
)
FILE_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
MAX_INPUT_BYTES = 8 * 1024 * 1024


class UnsafeWrite(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _safe_name(value: str) -> bool:
    if not isinstance(value, str) or not value or value in (".", ".."):
        return False
    if "\x00" in value or "/" in value or "\\" in value:
        return False
    try:
        return len(os.fsencode(value)) <= 255
    except UnicodeEncodeError:
        return False


def _canonical_absolute(value: str) -> bool:
    return (
        isinstance(value, str)
        and os.path.isabs(value)
        and os.path.normpath(value) == value
        and value != os.path.sep
    )


def _open_absolute_directory(
    path_value: str,
    expected_dev: int | None = None,
    expected_ino: int | None = None,
) -> int:
    """Open every component without following a symlink."""
    if not _canonical_absolute(path_value):
        raise UnsafeWrite("invalid-parent")
    fd = os.open(os.path.sep, DIR_FLAGS)
    try:
        for component in path_value.split(os.path.sep)[1:]:
            if not component:
                continue
            next_fd = os.open(component, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        opened = os.fstat(fd)
        if not stat.S_ISDIR(opened.st_mode):
            raise UnsafeWrite("parent-not-directory")
        if (
            expected_dev is not None
            and expected_ino is not None
            and (opened.st_dev != expected_dev or opened.st_ino != expected_ino)
        ):
            raise UnsafeWrite("parent-changed")
        return fd
    except Exception:
        os.close(fd)
        raise


def _same_named_directory(parent_fd: int, name: str, opened: os.stat_result) -> bool:
    try:
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        return False
    return (
        stat.S_ISDIR(named.st_mode)
        and named.st_dev == opened.st_dev
        and named.st_ino == opened.st_ino
    )


def _same_absolute_path(path_value: str, opened: os.stat_result) -> bool:
    try:
        named = os.stat(path_value, follow_symlinks=False)
    except OSError:
        return False
    return (
        stat.S_ISDIR(named.st_mode)
        and named.st_dev == opened.st_dev
        and named.st_ino == opened.st_ino
    )


def _open_or_create_child_directory(parent_fd: int, name: str):
    try:
        os.mkdir(name, 0o700, dir_fd=parent_fd)
    except FileExistsError:
        pass
    try:
        child_fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
    except OSError as exc:
        reason = (
            "unsafe-child"
            if exc.errno in (errno.ELOOP, errno.ENOTDIR)
            else "child-unavailable"
        )
        raise UnsafeWrite(reason) from exc
    child_stat = os.fstat(child_fd)
    if not stat.S_ISDIR(child_stat.st_mode) or not _same_named_directory(
        parent_fd, name, child_stat
    ):
        os.close(child_fd)
        raise UnsafeWrite("unsafe-child")
    return child_fd, child_stat


def _atomic_write_open_directory(
    directory_fd: int,
    file_name: str,
    data: bytes,
    max_bytes: int,
) -> None:
    if not _safe_name(file_name) or len(data) > max_bytes:
        raise UnsafeWrite("invalid-input")
    temp_name = f".{file_name}.{os.getpid()}.{secrets.token_hex(12)}.tmp"
    final_created = False
    try:
        file_fd = os.open(
            temp_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | FILE_NOFOLLOW,
            0o600,
            dir_fd=directory_fd,
        )
        try:
            opened_file = os.fstat(file_fd)
            if not stat.S_ISREG(opened_file.st_mode) or opened_file.st_nlink != 1:
                raise UnsafeWrite("unsafe-temp-file")
            view = memoryview(data)
            written = 0
            while written < len(view):
                count = os.write(file_fd, view[written:])
                if count <= 0:
                    raise UnsafeWrite("short-write")
                written += count
            os.fsync(file_fd)
        finally:
            os.close(file_fd)
        os.replace(
            temp_name,
            file_name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        temp_name = None
        final_created = True
        final_fd = os.open(
            file_name,
            os.O_RDONLY | FILE_NOFOLLOW,
            dir_fd=directory_fd,
        )
        try:
            final_stat = os.fstat(final_fd)
            if not stat.S_ISREG(final_stat.st_mode) or final_stat.st_nlink != 1:
                raise UnsafeWrite("unsafe-final-file")
        finally:
            os.close(final_fd)
    except Exception:
        if final_created:
            try:
                os.unlink(file_name, dir_fd=directory_fd)
            except OSError:
                pass
        raise
    finally:
        if temp_name is not None:
            try:
                os.unlink(temp_name, dir_fd=directory_fd)
            except OSError:
                pass


def safe_write_direct_child(
    parent_abs: str,
    child_name: str,
    file_name: str,
    data: bytes,
    max_bytes: int,
    after_child_open=None,
    expected_dev: int | None = None,
    expected_ino: int | None = None,
) -> dict[str, str]:
    """Write data safely; ``after_child_open`` is an import-only race-test seam."""
    if (
        not _canonical_absolute(parent_abs)
        or not _safe_name(child_name)
        or not _safe_name(file_name)
        or not isinstance(data, bytes)
        or not isinstance(max_bytes, int)
        or max_bytes <= 0
        or max_bytes > MAX_INPUT_BYTES
        or len(data) > max_bytes
    ):
        return {"status": "unsafe", "reason": "invalid-input"}

    parent_fd = None
    child_fd = None
    temp_name = None
    final_created = False
    try:
        parent_fd = _open_absolute_directory(
            parent_abs, expected_dev, expected_ino
        )
        child_fd, child_stat = _open_or_create_child_directory(
            parent_fd, child_name
        )

        if after_child_open is not None:
            after_child_open()

        _atomic_write_open_directory(child_fd, file_name, data, max_bytes)
        final_created = True

        if not _same_named_directory(parent_fd, child_name, child_stat):
            # The data stayed in the originally opened directory, never in the
            # replacement. Remove it from that inode and report fail-closed.
            os.unlink(file_name, dir_fd=child_fd)
            final_created = False
            raise UnsafeWrite("child-changed")

        return {
            "status": "written",
            "path": os.path.join(parent_abs, child_name, file_name),
        }
    except UnsafeWrite as exc:
        return {"status": "unsafe", "reason": exc.reason}
    except OSError as exc:
        return {"status": "unsafe", "reason": f"os-error-{exc.errno}"}
    finally:
        if child_fd is not None:
            if temp_name is not None:
                try:
                    os.unlink(temp_name, dir_fd=child_fd)
                except OSError:
                    pass
            # If validation failed after publication, best-effort cleanup is
            # safe because it is still anchored to the original child inode.
            if final_created and parent_fd is not None:
                try:
                    opened = os.fstat(child_fd)
                    if not _same_named_directory(parent_fd, child_name, opened):
                        os.unlink(file_name, dir_fd=child_fd)
                except OSError:
                    pass
            os.close(child_fd)
        if parent_fd is not None:
            os.close(parent_fd)


def _collect_markdown_files(
    root_fd: int,
    max_entries: int,
    max_depth: int = 16,
):
    found = []
    entries_seen = 0

    def walk(directory_fd: int, parts: tuple[str, ...], depth: int) -> None:
        nonlocal entries_seen
        try:
            names = sorted(os.listdir(directory_fd))
        except OSError as exc:
            raise UnsafeWrite("memory-scan-failed") from exc
        for name in names:
            entries_seen += 1
            if entries_seen > max_entries:
                raise UnsafeWrite("memory-entry-limit")
            if name.startswith("."):
                continue
            try:
                item = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            except OSError as exc:
                raise UnsafeWrite("memory-entry-changed") from exc
            if stat.S_ISDIR(item.st_mode):
                if name == "tombstones":
                    continue
                if depth >= max_depth:
                    raise UnsafeWrite("memory-depth-limit")
                try:
                    child_fd = os.open(name, DIR_FLAGS, dir_fd=directory_fd)
                except OSError as exc:
                    raise UnsafeWrite("unsafe-memory-directory") from exc
                try:
                    opened = os.fstat(child_fd)
                    if opened.st_dev != item.st_dev or opened.st_ino != item.st_ino:
                        raise UnsafeWrite("memory-entry-changed")
                    walk(child_fd, parts + (name,), depth + 1)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(item.st_mode) and name.endswith(".md"):
                if item.st_nlink != 1:
                    raise UnsafeWrite("memory-hardlink")
                found.append((parts + (name,), item.st_dev, item.st_ino))

    walk(root_fd, (), 0)
    return found


def _open_relative_parent(root_fd: int, parts: tuple[str, ...]):
    fd = os.dup(root_fd)
    try:
        for component in parts:
            next_fd = os.open(component, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except Exception:
        os.close(fd)
        raise


def safe_tombstone_markdown(
    memory_abs: str,
    tombstone_name: str,
    rename_stamp: str,
    metadata_bytes: bytes,
    max_bytes: int,
    max_entries: int,
    after_scan=None,
    expected_dev: int | None = None,
    expected_ino: int | None = None,
) -> dict:
    """Rename markdown via dirfds and publish one anchored audit tombstone."""
    if (
        not _canonical_absolute(memory_abs)
        or not _safe_name(tombstone_name)
        or not _safe_name(rename_stamp)
        or len(metadata_bytes) > max_bytes
        or max_bytes > MAX_INPUT_BYTES
        or max_entries <= 0
    ):
        return {"status": "unsafe", "reason": "invalid-input"}
    memory_fd = None
    tombstones_fd = None
    try:
        memory_fd = _open_absolute_directory(
            memory_abs, expected_dev, expected_ino
        )
        memory_stat = os.fstat(memory_fd)
        tombstones_fd, tombstones_stat = _open_or_create_child_directory(
            memory_fd, "tombstones"
        )
        try:
            metadata = json.loads(metadata_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise UnsafeWrite("invalid-metadata") from exc
        if not isinstance(metadata, dict) or "deleted_files" in metadata:
            raise UnsafeWrite("invalid-metadata")

        found = _collect_markdown_files(memory_fd, max_entries)
        deleted_rel = ["/".join(parts) for parts, _, _ in found]
        body = dict(metadata)
        body["deleted_files"] = deleted_rel
        tombstone_data = (
            json.dumps(body, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
        if len(tombstone_data) > max_bytes:
            raise UnsafeWrite("tombstone-too-large")

        if after_scan is not None:
            after_scan()

        renamed = []
        for parts, expected_dev, expected_ino in found:
            try:
                parent_fd = _open_relative_parent(memory_fd, parts[:-1])
            except OSError as exc:
                raise UnsafeWrite("unsafe-memory-directory") from exc
            try:
                name = parts[-1]
                current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                if (
                    not stat.S_ISREG(current.st_mode)
                    or current.st_nlink != 1
                    or current.st_dev != expected_dev
                    or current.st_ino != expected_ino
                ):
                    raise UnsafeWrite("memory-entry-changed")
                target = f"{name}.deleted-{rename_stamp}.tombstone"
                suffix = 1
                while True:
                    try:
                        os.stat(target, dir_fd=parent_fd, follow_symlinks=False)
                    except FileNotFoundError:
                        break
                    target = (
                        f"{name}.deleted-{rename_stamp}.{suffix}.tombstone"
                    )
                    suffix += 1
                    if suffix > 10_000:
                        raise UnsafeWrite("tombstone-collision-limit")
                os.rename(
                    name,
                    target,
                    src_dir_fd=parent_fd,
                    dst_dir_fd=parent_fd,
                )
                renamed.append("/".join(parts))
            finally:
                os.close(parent_fd)

        _atomic_write_open_directory(
            tombstones_fd, tombstone_name, tombstone_data, max_bytes
        )
        if (
            not _same_named_directory(memory_fd, "tombstones", tombstones_stat)
            or not _same_absolute_path(memory_abs, memory_stat)
        ):
            try:
                os.unlink(tombstone_name, dir_fd=tombstones_fd)
            except OSError:
                pass
            raise UnsafeWrite("memory-directory-changed")
        return {
            "status": "written",
            "path": os.path.join(memory_abs, "tombstones", tombstone_name),
            "deleted_files": renamed,
        }
    except UnsafeWrite as exc:
        return {"status": "unsafe", "reason": exc.reason}
    except OSError as exc:
        return {"status": "unsafe", "reason": f"os-error-{exc.errno}"}
    finally:
        if tombstones_fd is not None:
            os.close(tombstones_fd)
        if memory_fd is not None:
            os.close(memory_fd)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--operation",
        choices=("write", "tombstone-markdown"),
        default="write",
    )
    parser.add_argument("--parent", required=True)
    parser.add_argument("--child")
    parser.add_argument("--file", required=True)
    parser.add_argument("--max-bytes", required=True, type=int)
    parser.add_argument("--rename-stamp")
    parser.add_argument("--max-entries", type=int, default=10_000)
    parser.add_argument("--expected-dev", type=int)
    parser.add_argument("--expected-ino", type=int)
    args = parser.parse_args()

    if args.max_bytes <= 0 or args.max_bytes > MAX_INPUT_BYTES:
        result = {"status": "unsafe", "reason": "invalid-input"}
    else:
        data = sys.stdin.buffer.read(args.max_bytes + 1)
        if args.operation == "tombstone-markdown":
            result = safe_tombstone_markdown(
                args.parent,
                args.file,
                args.rename_stamp or "",
                data,
                args.max_bytes,
                args.max_entries,
                expected_dev=args.expected_dev,
                expected_ino=args.expected_ino,
            )
        elif not args.child:
            result = {"status": "unsafe", "reason": "invalid-input"}
        else:
            result = safe_write_direct_child(
                args.parent,
                args.child,
                args.file,
                data,
                args.max_bytes,
                expected_dev=args.expected_dev,
                expected_ino=args.expected_ino,
            )
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result.get("status") == "written" else 2


if __name__ == "__main__":
    raise SystemExit(main())
