#!/usr/bin/env python3
"""Skoobi Edge TTS adapter using Microsoft's current websocket endpoint."""

import argparse
import asyncio
import sys
from pathlib import Path

# The adapter relies on an internal edge-tts constant. Versions are pinned in
# scripts/edge-tts-requirements.txt; if the venv drifted, say so plainly
# instead of dumping a traceback (r1111, SEC-07).
try:
    import edge_tts
    import edge_tts.communicate as communicate_module
    from edge_tts.constants import TRUSTED_CLIENT_TOKEN
except ImportError as exc:
    sys.stderr.write(
        "edge-tts in this venv is missing or not the pinned version "
        f"({exc.__class__.__name__}: {exc}). Rebuild it: "
        "bash scripts/setup-edge-tts.sh --replace\n"
    )
    sys.exit(3)


MODERN_WSS_URL = (
    "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1"
    f"?Ocp-Apim-Subscription-Key={TRUSTED_CLIENT_TOKEN}"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice", required=True)
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--pitch", default="+0Hz")
    parser.add_argument("--file", required=True)
    parser.add_argument("--write-media", required=True)
    return parser.parse_args()


async def synthesize(args: argparse.Namespace) -> None:
    text = Path(args.file).read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("Cannot synthesize empty text")

    communicate_module.WSS_URL = MODERN_WSS_URL
    communicate_module.WSS_HEADERS["Sec-WebSocket-Protocol"] = "synthesize"

    communicator = edge_tts.Communicate(
        text,
        args.voice,
        rate=args.rate,
        pitch=args.pitch,
    )
    await communicator.save(args.write_media)


def main() -> None:
    asyncio.run(synthesize(parse_args()))


if __name__ == "__main__":
    main()
