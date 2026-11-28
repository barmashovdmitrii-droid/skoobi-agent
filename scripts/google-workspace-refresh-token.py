#!/usr/bin/env python3
"""Create a Google Workspace OAuth refresh token without exposing it on argv.

Credentials are read from SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID / _SECRET or
prompted interactively. The refresh token is written atomically with mode 0600;
its value is never printed.
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import hmac
import html
import http.server
import json
import os
import secrets
import stat
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_SCOPES = (
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.projects.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
)
CALLBACK_TIMEOUT_SECONDS = 600
NETWORK_TIMEOUT_SECONDS = 20
MAX_TOKEN_RESPONSE_BYTES = 64 * 1024
MAX_AUTHORIZATION_CODE_CHARS = 4096


def missing_granted_scopes(
    requested: tuple[str, ...], granted_value: object
) -> tuple[str, ...]:
    if not isinstance(granted_value, str):
        return tuple(sorted(set(requested)))
    granted = set(granted_value.replace(",", " ").split())
    return tuple(sorted(set(requested) - granted))


def required_credential(env_key: str, label: str, secret: bool = False) -> str:
    value = os.environ.get(env_key, "").strip()
    if value:
        return value
    if not sys.stdin.isatty():
        raise SystemExit(f"Missing {env_key}; run interactively or set it in the environment")
    prompt = f"{label}: "
    value = (getpass.getpass(prompt) if secret else input(prompt)).strip()
    if not value:
        raise SystemExit(f"{label} is required")
    return value


def atomic_private_write(path: str, value: str) -> None:
    directory = os.path.abspath(os.path.dirname(path))
    basename = os.path.basename(path)
    if not basename or basename in (".", "..") or os.sep in basename:
        raise RuntimeError("invalid secret output filename")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    directory_fd = os.open(
        directory,
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    temp = f".{basename}.{os.getpid()}.{secrets.token_hex(8)}.tmp"
    try:
        directory_stat = os.fstat(directory_fd)
        if not stat.S_ISDIR(directory_stat.st_mode):
            raise RuntimeError("secret output directory is not a real directory")
        os.fchmod(directory_fd, 0o700)
        directory_stat = os.fstat(directory_fd)
        current_stat = os.stat(directory, follow_symlinks=False)
        if (
            not stat.S_ISDIR(current_stat.st_mode)
            or current_stat.st_dev != directory_stat.st_dev
            or current_stat.st_ino != directory_stat.st_ino
        ):
            raise RuntimeError("secret output directory changed while opening")
        fd = os.open(
            temp,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=directory_fd,
        )
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        current_stat = os.stat(directory, follow_symlinks=False)
        if (
            current_stat.st_dev != directory_stat.st_dev
            or current_stat.st_ino != directory_stat.st_ino
        ):
            raise RuntimeError("secret output directory changed during write")
        os.replace(
            temp,
            basename,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        target_stat = os.stat(basename, dir_fd=directory_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(target_stat.st_mode)
            or target_stat.st_nlink != 1
            or stat.S_IMODE(target_stat.st_mode) != 0o600
        ):
            raise RuntimeError("secret output file metadata is unsafe")
        current_stat = os.stat(directory, follow_symlinks=False)
        if (
            current_stat.st_dev != directory_stat.st_dev
            or current_stat.st_ino != directory_stat.st_ino
        ):
            raise RuntimeError("secret output directory changed after replace")
        os.fsync(directory_fd)
    finally:
        try:
            os.unlink(temp, dir_fd=directory_fd)
        except FileNotFoundError:
            pass
        os.close(directory_fd)


def main() -> int:
    client_id = required_credential(
        "SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID", "OAuth client ID"
    )
    client_secret = required_credential(
        "SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET",
        "OAuth client secret",
        secret=True,
    )
    configured_scopes = os.environ.get("SKOOBI_GOOGLE_WORKSPACE_SCOPES", "")
    scopes = tuple(configured_scopes.replace(",", " ").split()) or DEFAULT_SCOPES
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode("ascii")).digest()
    ).rstrip(b"=").decode("ascii")
    result: dict[str, str] = {}
    done = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            query = urllib.parse.parse_qs(
                urllib.parse.urlparse(self.path).query,
                keep_blank_values=True,
                max_num_fields=20,
            )
            received_state = query.get("state", [""])[0]
            if not hmac.compare_digest(received_state, state):
                body = "<h2>Ошибка проверки OAuth state. Закройте вкладку.</h2>"
                status = 400
            elif query.get("code", [""])[0]:
                code = query["code"][0]
                if len(code) > MAX_AUTHORIZATION_CODE_CHARS:
                    result["error"] = "authorization_code_too_long"
                    body = "<h2>OAuth вернул слишком длинный код. Закройте вкладку.</h2>"
                    status = 400
                else:
                    result["code"] = code
                    body = "<h2>Готово — можно закрыть вкладку.</h2>"
                    status = 200
            else:
                result["error"] = query.get("error", ["unknown"])[0][:120]
                body = f"<h2>OAuth отказал: {html.escape(result['error'])}</h2>"
                status = 400
            encoded = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(encoded)
            # A random local request with the wrong state is rejected but must
            # not win a race and terminate the real browser authorization.
            if hmac.compare_digest(received_state, state):
                done.set()

        def log_message(self, *_args: object) -> None:
            return

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    redirect_uri = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(scopes),
            "access_type": "offline",
            "prompt": "consent",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    print("Откройте URL в браузере, если вкладка не открылась автоматически:")
    print(auth_url, flush=True)
    subprocess.run(["open", auth_url], check=False)

    try:
        if not done.wait(timeout=CALLBACK_TIMEOUT_SECONDS):
            print("OAuth callback timeout (10 minutes)", file=sys.stderr)
            return 1
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    if "code" not in result:
        print(f"OAuth failed: {result.get('error', 'unknown')}", file=sys.stderr)
        return 1

    request = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=urllib.parse.urlencode(
            {
                "code": result["code"],
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
                "code_verifier": verifier,
            }
        ).encode("ascii"),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(request, timeout=NETWORK_TIMEOUT_SECONDS) as response:
            encoded = response.read(MAX_TOKEN_RESPONSE_BYTES + 1)
            if len(encoded) > MAX_TOKEN_RESPONSE_BYTES:
                raise ValueError("token response too large")
            token_response = json.loads(encoded.decode("utf-8"))
    except urllib.error.HTTPError as error:
        # The upstream body is deliberately not echoed: providers sometimes
        # reflect submitted fields in diagnostics.
        print(f"Token exchange failed (HTTP {error.code})", file=sys.stderr)
        return 1
    except (
        urllib.error.URLError,
        TimeoutError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        ValueError,
    ) as error:
        print(f"Token exchange failed: {type(error).__name__}", file=sys.stderr)
        return 1

    refresh_token = token_response.get("refresh_token")
    if not isinstance(refresh_token, str) or not refresh_token:
        print("Google did not return a refresh_token; revoke consent and retry", file=sys.stderr)
        return 1
    missing_scopes = missing_granted_scopes(scopes, token_response.get("scope"))
    if missing_scopes:
        print(
            "Google did not grant every requested scope; token was not saved. Missing: "
            + " ".join(missing_scopes),
            file=sys.stderr,
        )
        return 1
    output = os.path.expanduser(
        os.environ.get(
            "SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN_FILE",
            "~/.claudeclaw-secrets/google-workspace-refresh-token",
        )
    )
    atomic_private_write(output, refresh_token)
    print(f"Refresh token saved securely: {output}")
    print("Granted scopes:", token_response.get("scope", "not reported"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
