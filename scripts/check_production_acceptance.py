#!/usr/bin/env python3
"""Check post-start health and readiness without logging credentials."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, build_opener

from preflight_production import parse_env_file


class AcceptanceError(RuntimeError):
    """A safe post-start acceptance failure."""


def _read_json(response: Any) -> tuple[int, Mapping[str, Any]]:
    try:
        status = int(response.status)
        body = json.loads(response.read().decode("utf-8"))
    except (AttributeError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise AcceptanceError("target returned a malformed JSON response") from exc
    if not isinstance(body, dict):
        raise AcceptanceError("target returned a JSON value instead of an object")
    return status, body


def _request_json(
    opener: Any,
    base_url: str,
    method: str,
    route: str,
    *,
    body: Mapping[str, Any] | None = None,
    token: str | None = None,
    timeout: float,
) -> tuple[int, Mapping[str, Any]]:
    headers = {"Accept": "application/json"}
    payload = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(body).encode("utf-8")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(
        urljoin(base_url.rstrip("/") + "/", route.lstrip("/")),
        data=payload,
        headers=headers,
        method=method,
    )
    try:
        with opener.open(request, timeout=timeout) as response:
            return _read_json(response)
    except HTTPError as exc:
        try:
            return _read_json(exc)
        except AcceptanceError as parse_exc:
            raise AcceptanceError(f"target returned HTTP {exc.code} with an invalid response") from parse_exc
    except (URLError, TimeoutError, OSError) as exc:
        raise AcceptanceError("target endpoint was not reachable") from exc


def check_acceptance(
    *,
    base_url: str,
    values: Mapping[str, str],
    timeout: float = 10,
    opener_factory: Callable[[], Any] = build_opener,
) -> str:
    opener = opener_factory()
    health_status, health = _request_json(opener, base_url, "GET", "/ingest/health", timeout=timeout)
    if health_status != 200 or health.get("status") != "ok":
        raise AcceptanceError("health endpoint did not return status ok")
    timestamp = health.get("timestamp")
    if not isinstance(timestamp, str):
        raise AcceptanceError("health endpoint did not return a timestamp")
    try:
        parsed_timestamp = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as exc:
        raise AcceptanceError("health endpoint returned an invalid timestamp") from exc
    if parsed_timestamp.tzinfo is None:
        raise AcceptanceError("health endpoint timestamp must include a timezone")

    login_status, login = _request_json(
        opener,
        base_url,
        "POST",
        "/admin/login",
        body={"email": values["ADMIN_EMAIL"], "password": values["ADMIN_PASSWORD"]},
        timeout=timeout,
    )
    token = login.get("token")
    if login_status != 200 or login.get("status") != "ok" or not isinstance(token, str) or not token:
        raise AcceptanceError("admin login did not return a session token")

    readiness_status, readiness = _request_json(
        opener,
        base_url,
        "GET",
        "/admin/readiness",
        token=token,
        timeout=timeout,
    )
    status = readiness.get("status")
    failed_count = readiness.get("failedCount")
    warning_count = readiness.get("warningCount")
    checks = readiness.get("checks")
    if readiness_status != 200 or status not in {"ready", "ready_with_warnings"}:
        raise AcceptanceError("readiness endpoint did not report a ready status")
    if type(failed_count) is not int or failed_count < 0:
        raise AcceptanceError("readiness endpoint reported a failed check")
    if type(warning_count) is not int or warning_count < 0:
        raise AcceptanceError("readiness endpoint returned an invalid warning count")
    if failed_count != 0:
        raise AcceptanceError("readiness endpoint reported failed checks")
    if status == "ready" and warning_count != 0:
        raise AcceptanceError("ready status must report zero warnings")
    if status == "ready_with_warnings" and warning_count <= 0:
        raise AcceptanceError("ready_with_warnings status must report a warning")
    if not isinstance(checks, list) or not checks:
        raise AcceptanceError("readiness endpoint returned no check details")
    if any(
        not isinstance(check, dict)
        or not isinstance(check.get("key"), str)
        or not check["key"].strip()
        or check.get("status") not in {"pass", "warn", "fail"}
        for check in checks
    ):
        raise AcceptanceError("readiness endpoint returned invalid check details")
    keys = [check["key"] for check in checks]
    if len(set(keys)) != len(keys):
        raise AcceptanceError("readiness endpoint returned duplicate check keys")
    mandatory_keys = {"database", "token_operation_schema", "reward_policy"}
    by_key = {check["key"]: check for check in checks}
    if not mandatory_keys.issubset(by_key):
        raise AcceptanceError("readiness endpoint omitted a mandatory persistence check")
    if any(by_key[key]["status"] != "pass" for key in mandatory_keys):
        raise AcceptanceError("readiness endpoint reported a mandatory persistence check that is not passing")
    failed_details = sum(check["status"] == "fail" for check in checks)
    warning_details = sum(check["status"] == "warn" for check in checks)
    if failed_details:
        raise AcceptanceError("readiness endpoint returned failed check details")
    if failed_details != failed_count:
        raise AcceptanceError("readiness failed count does not match check details")
    if warning_details != warning_count:
        raise AcceptanceError("readiness warning count does not match check details")
    return str(status)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:3005")
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--timeout", type=float, default=10)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)
    try:
        status = check_acceptance(
            base_url=args.base_url,
            values=parse_env_file(args.env_file),
            timeout=args.timeout,
        )
    except (AcceptanceError, KeyError) as exc:
        print(f"post-start acceptance failed: {exc}", file=sys.stderr)
        return 1
    if not args.quiet:
        print(f"post-start acceptance passed (health=ok, readiness={status})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
