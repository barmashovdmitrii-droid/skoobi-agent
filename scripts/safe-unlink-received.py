#!/usr/bin/env python3
"""Unlink one retention candidate through verified directory descriptors.

The group folder and its ``received`` child can be writable by a tenant.  A
normal pathname unlink therefore has a TOCTOU window: ``received`` can be
replaced with a symlink after a pathname check.  This helper opens both
directories with O_NOFOLLOW, verifies their identities, and calls unlinkat
through the already-open ``received`` descriptor.

The command prints one small JSON object with status ``deleted``, ``missing``
or ``unsafe``.  Only the first two statuses are safe for the caller to
tombstone in the media manifest.

Usage: ``safe-unlink-received.py <group folder> <basename> [<size>:<mtime_ns>[:<ino>]]``.
The optional third argument compares the entry's observed size, nanosecond
mtime and optional inode with the caller's verified copy. A mismatch refuses
deletion with status ``unsafe`` and reason ``entry-changed``. This check does
not make a concurrent replacement of the final directory entry atomic.
Without it the behaviour is unchanged (retention).
"""

import json
import os
import stat
import sys


_DIRECTORY_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_CLOEXEC", 0)
)


def _safe_basename(value):
    if not isinstance(value, str) or not value or value in (".", ".."):
        return False
    if "\x00" in value or "/" in value or "\\" in value:
        return False
    try:
        return len(os.fsencode(value)) <= 255
    except UnicodeEncodeError:
        return False


def _same_open_directory(parent_fd, name, opened_stat):
    """Return true only while ``name`` still denotes the opened directory."""
    try:
        named_stat = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        return False
    return (
        stat.S_ISDIR(named_stat.st_mode)
        and named_stat.st_dev == opened_stat.st_dev
        and named_stat.st_ino == opened_stat.st_ino
    )


def _same_group_path(folder_abs, opened_stat):
    try:
        named_stat = os.stat(folder_abs, follow_symlinks=False)
    except OSError:
        return False
    return (
        stat.S_ISDIR(named_stat.st_mode)
        and named_stat.st_dev == opened_stat.st_dev
        and named_stat.st_ino == opened_stat.st_ino
    )


def parse_expectation(value):
    """Parse ``<size>:<mtime_ns>[:<ino>]`` into a tuple, or None if malformed."""
    if not isinstance(value, str):
        return None
    parts = value.split(":")
    if len(parts) not in (2, 3) or not all(p.isascii() and p.isdigit() for p in parts):
        return None
    size, mtime_ns = int(parts[0]), int(parts[1])
    ino = int(parts[2]) if len(parts) == 3 else None
    return (size, mtime_ns, ino)


def safe_unlink_received(folder_abs, basename, after_received_open=None, expect=None):
    """Safely unlink ``basename`` from the real ``folder_abs/received`` inode.

    ``after_received_open`` is an import-only test seam.  The CLI never passes
    it; adversarial tests use it to replace ``received`` at the exact TOCTOU
    boundary and prove that the replacement is neither followed nor modified.

    ``expect`` is an optional ``(size, mtime_ns, ino_or_None)`` tuple: deletion
    is refused when the observed metadata differs from the caller's copy.
    """
    if (
        not isinstance(folder_abs, str)
        or not os.path.isabs(folder_abs)
        or os.path.normpath(folder_abs) != folder_abs
        or not _safe_basename(basename)
    ):
        return {"status": "unsafe", "reason": "invalid-input"}

    group_fd = None
    received_fd = None
    try:
        try:
            group_fd = os.open(folder_abs, _DIRECTORY_FLAGS)
            group_stat = os.fstat(group_fd)
        except OSError:
            return {"status": "unsafe", "reason": "group-open"}

        if not stat.S_ISDIR(group_stat.st_mode) or not _same_group_path(
            folder_abs, group_stat
        ):
            return {"status": "unsafe", "reason": "group-changed"}

        try:
            received_fd = os.open("received", _DIRECTORY_FLAGS, dir_fd=group_fd)
            received_stat = os.fstat(received_fd)
        except OSError:
            return {"status": "unsafe", "reason": "received-open"}

        if not stat.S_ISDIR(received_stat.st_mode):
            return {"status": "unsafe", "reason": "received-not-directory"}

        if after_received_open is not None:
            after_received_open()

        # Detect a rename/symlink swap before touching the entry.  Even if an
        # attacker swaps it immediately after this check, unlink below is still
        # pinned to received_fd and cannot follow the replacement directory.
        if not _same_group_path(folder_abs, group_stat) or not _same_open_directory(
            group_fd, "received", received_stat
        ):
            return {"status": "unsafe", "reason": "received-changed"}

        try:
            entry_stat = os.stat(basename, dir_fd=received_fd, follow_symlinks=False)
        except FileNotFoundError:
            return {"status": "missing"}
        except OSError:
            return {"status": "unsafe", "reason": "entry-stat"}

        # Retention owns ordinary media files only.  Refuse symlinks, FIFOs,
        # devices, directories, and multiply-linked files instead of widening
        # the deletion primitive beyond its intended behavior.
        if not stat.S_ISREG(entry_stat.st_mode) or entry_stat.st_nlink != 1:
            return {"status": "unsafe", "reason": "entry-not-private-file"}

        if expect is not None:
            size, mtime_ns, ino = expect
            if (
                entry_stat.st_size != size
                or entry_stat.st_mtime_ns != mtime_ns
                or (ino is not None and entry_stat.st_ino != ino)
            ):
                return {"status": "unsafe", "reason": "entry-changed"}

        if not _same_group_path(folder_abs, group_stat) or not _same_open_directory(
            group_fd, "received", received_stat
        ):
            return {"status": "unsafe", "reason": "received-changed"}

        try:
            # Python implements dir_fd with unlinkat(2).  No pathname component
            # above basename is resolved again here.
            os.unlink(basename, dir_fd=received_fd)
        except FileNotFoundError:
            return {"status": "missing"}
        except OSError:
            return {"status": "unsafe", "reason": "unlink-failed"}
        return {"status": "deleted"}
    finally:
        if received_fd is not None:
            os.close(received_fd)
        if group_fd is not None:
            os.close(group_fd)


def main(argv):
    if len(argv) == 3:
        result = safe_unlink_received(argv[1], argv[2])
    elif len(argv) == 4 and parse_expectation(argv[3]) is not None:
        result = safe_unlink_received(argv[1], argv[2], expect=parse_expectation(argv[3]))
    else:
        result = {"status": "unsafe", "reason": "invalid-arguments"}
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
