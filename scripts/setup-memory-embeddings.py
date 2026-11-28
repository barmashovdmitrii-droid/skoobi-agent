#!/usr/bin/env python3
"""Explicit operator setup only; no runtime auto-install/download.

Pinned public model revision + exact upstream LFS SHA256 and byte limits.
Creates an isolated venv. Never changes the speech model or global Python.
"""
import argparse
import hashlib
import os
import pathlib
import subprocess
import time
import urllib.request
import venv

REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
FILES = {
    "model.onnx": ("onnx/model.onnx", 470268510, "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665"),
    "tokenizer.json": ("tokenizer.json", 17082730, "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"),
}
PACKAGES = ["onnxruntime==1.25.1", "numpy==2.4.4", "tokenizers==0.22.2", "flatbuffers==25.12.19", "packaging==26.3", "protobuf==7.36.2"]


def valid(file, size, digest):
    if not file.is_file() or file.is_symlink() or file.stat().st_size != size:
        return False
    with file.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest() == digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, help="New private directory outside the source checkout")
    args = parser.parse_args()
    root = pathlib.Path(args.target).expanduser().absolute()
    if root.is_symlink() or root == pathlib.Path.home() or pathlib.Path(__file__).resolve().parents[1] in root.parents:
        raise ValueError("Use a dedicated external directory")
    os.umask(0o077)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    (root / "model").mkdir(mode=0o700, exist_ok=True)
    venv.EnvBuilder(with_pip=True).create(root / "venv")
    python = root / "venv/bin/python"
    # No optional hub/network loaders or transitive resolver drift. Tokenizer's
    # local from_file API needs no huggingface-hub (from_pretrained is not used).
    subprocess.run([str(python), "-m", "pip", "--isolated", "install", "--only-binary=:all:", "--no-deps", "--disable-pip-version-check", *PACKAGES], check=True, timeout=300)
    for name, (remote, size, digest) in FILES.items():
        target = root / "model" / name
        if valid(target, size, digest):
            continue
        partial = target.with_suffix(target.suffix + ".part")
        if partial.exists() or partial.is_symlink():
            partial.unlink()
        request = urllib.request.Request(f"https://huggingface.co/intfloat/multilingual-e5-small/resolve/{REVISION}/{remote}", headers={"User-Agent": "skoobi-explicit-model-setup/1"})
        try:
            deadline = time.monotonic() + 300
            with urllib.request.urlopen(request, timeout=60) as source, partial.open("xb") as output:
                received = 0
                while block := source.read(1024 * 1024):
                    received += len(block)
                    if received > size or time.monotonic() > deadline:
                        raise ValueError("model_size_limit")
                    output.write(block)
                output.flush()
                os.fsync(output.fileno())
            if not valid(partial, size, digest):
                raise ValueError("model_integrity")
            os.replace(partial, target)
        finally:
            partial.unlink(missing_ok=True)
    print("Pinned local embeddings installed. Runtime remains lexical until explicitly enabled.")


if __name__ == "__main__":
    main()
