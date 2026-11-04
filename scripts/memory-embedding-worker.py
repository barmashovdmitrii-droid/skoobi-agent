#!/usr/bin/env python3
"""Offline E5 inference. Only stdin text -> stdout vectors; never log content.

No transformers/hub loader, remote code, model discovery, or runtime download.
The published model/tokenizer bytes are checked before loading native code.
"""
import argparse
import hashlib
import json
import pathlib
import sys

REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
FINGERPRINT = f"multilingual-e5-small:{REVISION}:mean-l2:512:v1"
FILES = {
    "model.onnx": (470268510, "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665"),
    "tokenizer.json": (17082730, "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"),
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()
    root = pathlib.Path(args.model_dir)
    for name, (size, digest) in FILES.items():
        file = root / name
        if file.is_symlink() or file.stat().st_size != size:
            raise ValueError("model_integrity")
        with file.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != digest:
                raise ValueError("model_integrity")
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer

    tokenizer = Tokenizer.from_file(str(root / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=512)
    tokenizer.enable_padding(pad_id=1, pad_token="<pad>")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.log_severity_level = 4
    session = ort.InferenceSession(str(root / "model.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
    names = {item.name for item in session.get_inputs()}
    while True:
        line = sys.stdin.buffer.readline(1024 * 1024 + 1)
        if not line:
            return
        if len(line) > 1024 * 1024 or not line.endswith(b"\n"):
            raise ValueError("input_limit")
        request = json.loads(line)
        texts, kind = request["texts"], request["kind"]
        if kind not in ("query", "passage") or not isinstance(texts, list) or not 1 <= len(texts) <= 64 or any(not isinstance(t, str) or not t.strip() or len(t) > 6000 for t in texts):
            raise ValueError("input_limit")
        vectors = []
        # Four texts cap peak attention allocation even for 512-token passages.
        for start in range(0, len(texts), 4):
            encoded = tokenizer.encode_batch([f"{kind}: {text}" for text in texts[start:start + 4]])
            ids = np.asarray([item.ids for item in encoded], dtype=np.int64)
            mask = np.asarray([item.attention_mask for item in encoded], dtype=np.int64)
            inputs = {"input_ids": ids, "attention_mask": mask}
            if "token_type_ids" in names:
                inputs["token_type_ids"] = np.zeros_like(ids)
            output = session.run(None, inputs)[0]
            expanded = mask[:, :, None]
            mean = (output * expanded).sum(axis=1) / expanded.sum(axis=1)
            mean /= np.linalg.norm(mean, axis=1, keepdims=True)
            if mean.shape[1] != 384 or not np.isfinite(mean).all():
                raise ValueError("output_invalid")
            vectors.extend(mean.tolist())
        print(json.dumps({"fingerprint": FINGERPRINT, "vectors": vectors}, separators=(",", ":"), allow_nan=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Content, filesystem paths and native exception strings stay private.
        print("local_embedding_unavailable", file=sys.stderr)
        sys.exit(1)
