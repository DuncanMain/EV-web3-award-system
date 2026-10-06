#!/usr/bin/env python3
"""Validate production deployment inputs without changing the target."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import parse_qs, unquote, urlparse


IMAGE_REFERENCE_RE = re.compile(
    r"^ghcr\.io/zentrixlab/neverflat@sha256:[0-9a-f]{64}$",
    re.IGNORECASE,
)
REQUIRED_ENV = (
    "DATABASE_URL",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_VOLUME_NAME",
    "COMPOSE_PROJECT_NAME",
    "INGEST_API_KEY",
    "ADMIN_EMAIL",
    "ADMIN_PASSWORD",
    "DEPLOY_ENV_FILE",
)
COMPOSE_ENV_KEYS = (
    "DATABASE_URL",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_VOLUME_NAME",
    "COMPOSE_PROJECT_NAME",
    "DEPLOY_ENV_FILE",
)
DATABASE_QUERY_OVERRIDES = {"host", "port", "user", "password", "dbname", "database"}


class PreflightError(RuntimeError):
    """A safe, operator-actionable preflight failure."""


def parse_env_file(path: str | Path) -> dict[str, str]:
    """Parse the simple KEY=VALUE form used by the operator env file."""

    env_path = Path(path)
    if not env_path.is_file():
        raise PreflightError("operator environment file is missing")

    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(env_path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise PreflightError(f"operator environment line {line_number} is malformed")
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise PreflightError(f"operator environment line {line_number} has an invalid key")
        value = raw_value.strip()
        if value and value[0] in "'\"":
            try:
                parsed = shlex.split(value, comments=False, posix=True)
            except ValueError as exc:
                raise PreflightError(f"operator environment line {line_number} has invalid quoting") from exc
            if len(parsed) > 1:
                raise PreflightError(f"operator environment line {line_number} has an unquoted value")
            value = parsed[0] if parsed else ""
        values[key] = value
    return values


def validate_image_reference(image_reference: str) -> None:
    if not IMAGE_REFERENCE_RE.fullmatch(image_reference.strip()):
        raise PreflightError("IMAGE_REFERENCE must be the Zentrix neverflat sha256 image digest")


def validate_release_pointer(deploy_dir: str | Path) -> None:
    """Refuse to deploy over an active release path that is not a symlink."""

    current = Path(deploy_dir) / "current"
    if (current.exists() or current.is_symlink()) and not current.is_symlink():
        raise PreflightError("active release path is not a symlink; refusing to replace it")


def validate_operator_env(values: Mapping[str, str], env_file: str | Path) -> None:
    missing = [key for key in REQUIRED_ENV if not str(values.get(key, "")).strip()]
    if missing:
        raise PreflightError(f"operator environment is missing required settings: {', '.join(missing)}")

    if values["COMPOSE_PROJECT_NAME"] != "neverflat":
        raise PreflightError("COMPOSE_PROJECT_NAME must remain neverflat for the existing project and volume")

    deploy_env_file = Path(values["DEPLOY_ENV_FILE"]).resolve()
    if deploy_env_file != Path(env_file).resolve():
        raise PreflightError("DEPLOY_ENV_FILE must point to the operator environment file used for this rollout")

    database_url = values["DATABASE_URL"]
    parsed = urlparse(database_url)
    if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
        raise PreflightError("DATABASE_URL must be a PostgreSQL connection URL")
    if not parsed.username or not parsed.password or not parsed.path.strip("/"):
        raise PreflightError("DATABASE_URL must include an explicit user, password, and database")
    try:
        database_port = parsed.port
    except ValueError as exc:
        raise PreflightError("DATABASE_URL must use a numeric PostgreSQL port") from exc
    if parsed.hostname.lower() != "postgres" or database_port != 5432:
        raise PreflightError("DATABASE_URL must use the production Compose postgres service on port 5432")
    query_overrides = sorted({key.lower() for key in parse_qs(parsed.query, keep_blank_values=True) if key.lower() in DATABASE_QUERY_OVERRIDES})
    if query_overrides:
        raise PreflightError("DATABASE_URL cannot override connection identity through query parameters")
    if unquote(parsed.password) != values["POSTGRES_PASSWORD"]:
        raise PreflightError("DATABASE_URL password must match the existing PostgreSQL container credential")
    if unquote(parsed.username) != values["POSTGRES_USER"]:
        raise PreflightError("DATABASE_URL user must match the existing PostgreSQL container role")
    if unquote(parsed.path.strip("/")) != values["POSTGRES_DB"]:
        raise PreflightError("DATABASE_URL database must match the existing PostgreSQL database")

    if not values.get("API_KEY") and not values.get("BEIA_API_KEY"):
        raise PreflightError("operator environment must set API_KEY or BEIA_API_KEY")


def effective_compose_environment(
    values: Mapping[str, str],
    image_reference: str,
    host_environment: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Return the Compose environment and reject stale shell overrides.

    Compose gives exported shell variables precedence over ``--env-file``.
    The deploy shell uses the same host environment after this check, so a
    conflicting exported value must fail before any target mutation.
    """

    expected = {key: values[key] for key in COMPOSE_ENV_KEYS}
    expected["IMAGE_REFERENCE"] = image_reference
    effective = dict(os.environ if host_environment is None else host_environment)
    conflicts = sorted(
        key for key, value in expected.items()
        if key in effective and effective[key] != value
    )
    if conflicts:
        raise PreflightError(
            "host environment overrides operator Compose settings: "
            + ", ".join(conflicts)
        )
    effective.update(expected)
    return effective


def validate_database_snapshot(snapshot: Mapping[str, Any], values: Mapping[str, str]) -> None:
    project = snapshot.get("Config", {}).get("Labels", {}).get("com.docker.compose.project")
    if project != values["COMPOSE_PROJECT_NAME"]:
        raise PreflightError("existing PostgreSQL container belongs to a different Compose project")

    mounts = snapshot.get("Mounts", [])
    data_mounts = [
        mount for mount in mounts
        if mount.get("Destination") == "/var/lib/postgresql/data" and mount.get("Type") == "volume"
    ]
    if len(data_mounts) != 1:
        raise PreflightError("existing PostgreSQL container does not expose one named data volume")
    if data_mounts[0].get("Name") != values["POSTGRES_VOLUME_NAME"]:
        raise PreflightError("POSTGRES_VOLUME_NAME does not match the existing PostgreSQL data volume")

    container_env = {}
    for item in snapshot.get("Config", {}).get("Env", []):
        if "=" in item:
            key, value = item.split("=", 1)
            container_env[key] = value
    for key in ("POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"):
        if container_env.get(key) != values[key]:
            raise PreflightError(f"{key} does not match the existing PostgreSQL container credential")


def _run_checked(command: list[str], *, env: Mapping[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=dict(env) if env is not None else None,
        )
    except FileNotFoundError as exc:
        raise PreflightError(f"required executable is unavailable: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        raise PreflightError(f"required preflight command failed: {command[0]}") from exc


def docker_snapshot(container_name: str) -> Mapping[str, Any]:
    result = _run_checked(["docker", "inspect", container_name])
    try:
        rows = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise PreflightError("Docker returned an invalid container inspection") from exc
    if not rows:
        raise PreflightError("existing PostgreSQL container was not found")
    return rows[0]


def validate_effective_compose_config(
    config: Mapping[str, Any],
    values: Mapping[str, str],
    image_reference: str,
) -> None:
    """Validate the rendered Compose model without exposing its secrets."""

    if config.get("name") != values["COMPOSE_PROJECT_NAME"]:
        raise PreflightError("rendered Compose project does not preserve neverflat")
    services = config.get("services")
    if not isinstance(services, Mapping):
        raise PreflightError("rendered Compose configuration has no services")
    app = services.get("app")
    postgres = services.get("postgres")
    if not isinstance(app, Mapping) or not isinstance(postgres, Mapping):
        raise PreflightError("rendered Compose configuration is missing app or postgres")
    if app.get("image") != image_reference:
        raise PreflightError("rendered app image does not match the requested immutable digest")

    app_environment = app.get("environment")
    postgres_environment = postgres.get("environment")
    if not isinstance(app_environment, Mapping) or not isinstance(postgres_environment, Mapping):
        raise PreflightError("rendered Compose configuration does not expose explicit service settings")
    if app_environment.get("DATABASE_URL") != values["DATABASE_URL"]:
        raise PreflightError("rendered DATABASE_URL does not match the operator environment")
    for key in ("POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"):
        if postgres_environment.get(key) != values[key]:
            raise PreflightError(f"rendered {key} does not match the existing PostgreSQL credential")

    volumes = config.get("volumes")
    pgdata = volumes.get("pgdata") if isinstance(volumes, Mapping) else None
    if not isinstance(pgdata, Mapping) or pgdata.get("name") != values["POSTGRES_VOLUME_NAME"]:
        raise PreflightError("rendered PostgreSQL volume does not preserve the target volume name")
    postgres_mounts = postgres.get("volumes")
    if not isinstance(postgres_mounts, list) or not any(
        isinstance(mount, Mapping)
        and mount.get("type") == "volume"
        and mount.get("source") == "pgdata"
        and mount.get("target") == "/var/lib/postgresql/data"
        for mount in postgres_mounts
    ):
        raise PreflightError("rendered PostgreSQL service does not mount the pgdata volume")


def run_preflight(
    *,
    deploy_dir: str | Path,
    env_file: str | Path,
    image_reference: str,
    compose_file: str | Path | None = None,
) -> dict[str, str]:
    """Run all checks and return non-secret settings needed by the deployer."""

    validate_release_pointer(deploy_dir)
    validate_image_reference(image_reference)
    values = parse_env_file(env_file)
    validate_operator_env(values, env_file)
    compose_env = effective_compose_environment(values, image_reference)
    _run_checked(["docker", "info"])
    _run_checked(["docker", "compose", "version"])
    validate_database_snapshot(docker_snapshot("neverflat-db"), values)

    if compose_file is not None:
        compose_path = Path(compose_file)
        if not compose_path.is_file():
            raise PreflightError("staged production Compose file is missing")
        rendered = _run_checked(
            [
                "docker", "compose",
                "--project-name", values["COMPOSE_PROJECT_NAME"],
                "--env-file", str(Path(env_file).resolve()),
                "-f", str(compose_path.resolve()),
                "config", "--format", "json",
            ],
            env=compose_env,
        )
        try:
            rendered_config = json.loads(rendered.stdout)
        except json.JSONDecodeError as exc:
            raise PreflightError("Docker Compose returned an invalid rendered configuration") from exc
        if not isinstance(rendered_config, Mapping):
            raise PreflightError("Docker Compose rendered a non-object configuration")
        validate_effective_compose_config(rendered_config, values, image_reference)
    return {
        "COMPOSE_PROJECT_NAME": values["COMPOSE_PROJECT_NAME"],
        "POSTGRES_VOLUME_NAME": values["POSTGRES_VOLUME_NAME"],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deploy-dir", required=True)
    parser.add_argument("--env-file")
    parser.add_argument("--compose-file")
    parser.add_argument("--image-reference", required=True)
    args = parser.parse_args(argv)
    env_file = Path(args.env_file or Path(args.deploy_dir) / ".env")
    try:
        result = run_preflight(
            deploy_dir=args.deploy_dir,
            env_file=env_file,
            image_reference=args.image_reference,
            compose_file=args.compose_file,
        )
    except PreflightError as exc:
        print(f"production preflight failed: {exc}", file=sys.stderr)
        return 1
    print(f"production preflight passed (project={result['COMPOSE_PROJECT_NAME']}, volume identity preserved)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
