#!/usr/bin/env python3
"""Focused, offline checks for the production deployment helpers."""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True


def load_helper(name: str):
    path = ROOT / "scripts" / name
    spec = importlib.util.spec_from_file_location(path.stem, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[path.stem] = module
    spec.loader.exec_module(module)
    return module


preflight = load_helper("preflight_production.py")
acceptance = load_helper("check_production_acceptance.py")


VALID_ENV = {
    "DATABASE_URL": "postgres://postgres:target-secret@postgres:5432/nvf_award",
    "POSTGRES_DB": "nvf_award",
    "POSTGRES_USER": "postgres",
    "POSTGRES_PASSWORD": "target-secret",
    "POSTGRES_VOLUME_NAME": "neverflat_pgdata",
    "COMPOSE_PROJECT_NAME": "neverflat",
    "DEPLOY_ENV_FILE": "PLACEHOLDER",
    "API_KEY": "api-secret",
    "INGEST_API_KEY": "ingest-secret",
    "ADMIN_EMAIL": "admin@example.com",
    "ADMIN_PASSWORD": "admin-secret",
}
SOURCE_COMMIT = "1" * 40
IMAGE_REFERENCE = "ghcr.io/zentrixlab/neverflat@sha256:" + "a" * 64


def valid_release_record(values: dict[str, str], source_commit: str = SOURCE_COMMIT, image_reference: str = IMAGE_REFERENCE) -> dict:
    return {
        "schemaVersion": 1,
        "sourceCommit": source_commit,
        "imageReference": image_reference,
        "target": preflight._expected_target_identity(values),
        "evidence": {
            "backupVerified": True,
            "restoreVerified": True,
            "writersQuiesced": True,
            "migrationReviewed": True,
            "migrationApplied": True,
            "preservationVerified": True,
        },
        "approvedBy": "target-operator",
        "approvedAt": "2026-10-08T12:00:00Z",
        "expiresAt": "2026-10-08T20:00:00Z",
    }


class FakeResponse:
    def __init__(self, status: int, payload: dict):
        self.status = status
        self._payload = payload

    def read(self) -> bytes:
        import json
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class FakeOpener:
    def __init__(self, responses):
        self.responses = list(responses)

    def open(self, _request, timeout):
        del timeout
        return self.responses.pop(0)


class DeploymentHelperTests(unittest.TestCase):
    def test_operator_env_and_digest_validation(self):
        with tempfile.TemporaryDirectory() as temp:
            env_path = Path(temp) / ".env"
            values = dict(VALID_ENV, DEPLOY_ENV_FILE=str(env_path))
            env_path.write_text(
                "\n".join(f"{key}={value}" for key, value in values.items()) + "\n",
                encoding="utf-8",
            )
            parsed = preflight.parse_env_file(env_path)
            preflight.validate_operator_env(parsed, env_path)
            preflight.validate_image_reference("ghcr.io/zentrixlab/neverflat@sha256:" + "a" * 64)
            with self.assertRaises(preflight.PreflightError):
                preflight.validate_image_reference("ghcr.io/zentrixlab/neverflat:latest")

    def test_preflight_accepts_existing_simple_credentials_and_rejects_missing_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            env_path = Path(temp) / ".env"
            values = dict(
                VALID_ENV,
                DEPLOY_ENV_FILE=str(env_path),
                DATABASE_URL="postgres://postgres:postgres@postgres:5432/nvf_award",
                POSTGRES_PASSWORD="postgres",
                ADMIN_PASSWORD="password",
            )
            preflight.validate_operator_env(values, env_path)
            values = dict(VALID_ENV, DEPLOY_ENV_FILE=str(env_path))
            values.pop("DATABASE_URL")
            with self.assertRaises(preflight.PreflightError):
                preflight.validate_operator_env(values, env_path)

    def test_preflight_rejects_non_symlink_active_release_path(self):
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / "current").mkdir()
            with self.assertRaises(preflight.PreflightError):
                preflight.validate_release_pointer(temp)

    def test_preflight_requires_prior_app_to_be_stopped(self):
        preflight.validate_existing_app_stopped(None)
        preflight.validate_existing_app_stopped({"State": {"Status": "exited"}})
        with self.assertRaises(preflight.PreflightError):
            preflight.validate_existing_app_stopped({"State": {"Status": "running"}})
        with self.assertRaises(preflight.PreflightError):
            preflight.validate_existing_app_stopped({"State": {"Status": "restarting"}})

    def test_preflight_rejects_database_url_overrides_and_stale_host_environment(self):
        image = "ghcr.io/zentrixlab/neverflat@sha256:" + "a" * 64
        with self.assertRaises(preflight.PreflightError):
            preflight.validate_operator_env(
                dict(
                    VALID_ENV,
                    DATABASE_URL="postgres://postgres:target-secret@postgres:5432/nvf_award?host=other-db",
                ),
                "PLACEHOLDER",
            )
        for override in (
            {"DATABASE_URL": "postgres://postgres:stale@postgres:5432/nvf_award"},
            {"POSTGRES_VOLUME_NAME": "another_target_volume"},
        ):
            with self.assertRaises(preflight.PreflightError):
                preflight.effective_compose_environment(VALID_ENV, image, override)
        effective = preflight.effective_compose_environment(VALID_ENV, image, {"PATH": "safe"})
        self.assertEqual(effective["DATABASE_URL"], VALID_ENV["DATABASE_URL"])
        self.assertEqual(effective["IMAGE_REFERENCE"], image)

    def test_rendered_compose_config_preserves_digest_volume_and_credentials(self):
        image = "ghcr.io/zentrixlab/neverflat@sha256:" + "a" * 64
        config = {
            "name": "neverflat",
            "services": {
                "app": {
                    "image": image,
                    "command": ["node", "dist/api.js"],
                    "environment": {"DATABASE_URL": VALID_ENV["DATABASE_URL"]},
                },
                "postgres": {
                    "environment": {
                        "POSTGRES_DB": VALID_ENV["POSTGRES_DB"],
                        "POSTGRES_USER": VALID_ENV["POSTGRES_USER"],
                        "POSTGRES_PASSWORD": VALID_ENV["POSTGRES_PASSWORD"],
                    },
                    "volumes": [{
                        "type": "volume",
                        "source": "pgdata",
                        "target": "/var/lib/postgresql/data",
                    }],
                },
            },
            "volumes": {"pgdata": {"name": VALID_ENV["POSTGRES_VOLUME_NAME"]}},
        }
        preflight.validate_effective_compose_config(config, VALID_ENV, image)

        wrong_image = copy.deepcopy(config)
        wrong_image["services"]["app"]["image"] = image.replace("a" * 64, "b" * 64)
        with self.assertRaises(preflight.PreflightError):
            preflight.validate_effective_compose_config(wrong_image, VALID_ENV, image)

        wrong_volume = copy.deepcopy(config)
        wrong_volume["volumes"]["pgdata"]["name"] = "another_target_volume"
        with self.assertRaises(preflight.PreflightError):
            preflight.validate_effective_compose_config(wrong_volume, VALID_ENV, image)

    def test_preflight_rejects_changed_volume_or_credentials(self):
        values = dict(VALID_ENV)
        snapshot = {
            "Name": "/neverflat-db",
            "State": {"Status": "running", "Health": {"Status": "healthy"}},
            "Config": {
                "Labels": {"com.docker.compose.project": "neverflat"},
                "Env": ["POSTGRES_DB=nvf_award", "POSTGRES_USER=postgres", "POSTGRES_PASSWORD=other"],
            },
            "Mounts": [{"Type": "volume", "Name": "other_volume", "Destination": "/var/lib/postgresql/data"}],
        }
        with self.assertRaises(preflight.PreflightError):
            preflight.validate_database_snapshot(snapshot, values)

    def test_target_release_gate_is_exact_bounded_and_complete(self):
        values = dict(VALID_ENV)
        now = datetime(2026, 10, 8, 16, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as temp:
            record_path = Path(temp) / "approval.json"
            record = valid_release_record(values)
            record_path.write_text(json.dumps(record), encoding="utf-8")
            accepted = preflight.validate_release_record(
                record_path,
                source_commit=SOURCE_COMMIT,
                image_reference=IMAGE_REFERENCE,
                values=values,
                now=now,
            )
            self.assertEqual(accepted["target"]["postgresVolumeName"], values["POSTGRES_VOLUME_NAME"])

            invalid_records = []
            mismatched_source = copy.deepcopy(record)
            mismatched_source["sourceCommit"] = "2" * 40
            invalid_records.append(mismatched_source)
            stale = copy.deepcopy(record)
            stale["expiresAt"] = "2026-10-08T15:00:00Z"
            invalid_records.append(stale)
            future_approval = copy.deepcopy(record)
            future_approval["approvedAt"] = "2026-10-08T17:00:00Z"
            invalid_records.append(future_approval)
            long_window = copy.deepcopy(record)
            long_window["approvedAt"] = "2026-10-08T00:00:00Z"
            long_window["expiresAt"] = "2026-10-09T01:00:00Z"
            invalid_records.append(long_window)
            mismatched_digest = copy.deepcopy(record)
            mismatched_digest["imageReference"] = "ghcr.io/zentrixlab/neverflat@sha256:" + "c" * 64
            invalid_records.append(mismatched_digest)
            incomplete = copy.deepcopy(record)
            incomplete["evidence"]["migrationApplied"] = False
            invalid_records.append(incomplete)
            wrong_target = copy.deepcopy(record)
            wrong_target["target"]["postgresVolumeName"] = "other-volume"
            invalid_records.append(wrong_target)
            for invalid in invalid_records:
                record_path.write_text(json.dumps(invalid), encoding="utf-8")
                with self.assertRaises(preflight.PreflightError):
                    preflight.validate_release_record(
                        record_path,
                        source_commit=SOURCE_COMMIT,
                        image_reference=IMAGE_REFERENCE,
                        values=values,
                        now=now,
                    )

            record_path.write_text("{broken", encoding="utf-8")
            with self.assertRaises(preflight.PreflightError):
                preflight.validate_release_record(
                    record_path,
                    source_commit=SOURCE_COMMIT,
                    image_reference=IMAGE_REFERENCE,
                    values=values,
                    now=now,
                )

    def test_target_schema_check_requires_all_read_only_checks(self):
        passing = {key: True for key in preflight.REQUIRED_SCHEMA_CHECKS}
        completed = subprocess.CompletedProcess([], 0, json.dumps(passing), "")
        with patch.object(preflight, "_run_checked", return_value=completed) as run_checked:
            preflight.validate_target_schema()
            run_checked.assert_called_once()
            self.assertIn("users_uid_unique", run_checked.call_args.args[0][-1])

        failing = dict(passing, active_wallet_unique=False)
        with patch.object(
            preflight,
            "_run_checked",
            return_value=subprocess.CompletedProcess([], 0, json.dumps(failing), ""),
        ):
            with self.assertRaises(preflight.PreflightError):
                preflight.validate_target_schema()

    def test_acceptance_success(self):
        opener = FakeOpener([
            FakeResponse(200, {"status": "ok", "timestamp": "2026-10-06T12:00:00.000Z"}),
            FakeResponse(200, {"status": "ok", "token": "opaque-session"}),
            FakeResponse(200, {
                "status": "ready_with_warnings",
                "failedCount": 0,
                "warningCount": 1,
                "checks": [
                    {"key": "database", "label": "Database", "status": "pass"},
                    {"key": "token_operation_schema", "label": "Durable token operation schema", "status": "pass"},
                    {"key": "reward_policy", "label": "Durable reward policy", "status": "pass"},
                    {"key": "token_operation_legacy_hash_review", "label": "Historical transaction hashes", "status": "warn"},
                ],
            }),
        ])
        status = acceptance.check_acceptance(
            base_url="http://127.0.0.1:3005",
            values=VALID_ENV,
            opener_factory=lambda: opener,
        )
        self.assertEqual(status, "ready_with_warnings")

    def test_acceptance_rejects_health_and_readiness_failures(self):
        bad_health = FakeOpener([FakeResponse(200, {"status": "ok", "timestamp": "bad"})])
        with self.assertRaises(acceptance.AcceptanceError):
            acceptance.check_acceptance(
                base_url="http://127.0.0.1:3005",
                values=VALID_ENV,
                opener_factory=lambda: bad_health,
            )
        bad_readiness = FakeOpener([
            FakeResponse(200, {"status": "ok", "timestamp": "2026-10-06T12:00:00.000Z"}),
            FakeResponse(200, {"status": "ok", "token": "opaque-session"}),
            FakeResponse(503, {
                "status": "not_ready",
                "failedCount": 1,
                "warningCount": 0,
                "checks": [
                    {"key": "database", "status": "pass"},
                    {"key": "token_operation_schema", "status": "fail"},
                    {"key": "reward_policy", "status": "pass"},
                ],
            }),
        ])
        with self.assertRaises(acceptance.AcceptanceError):
            acceptance.check_acceptance(
                base_url="http://127.0.0.1:3005",
                values=VALID_ENV,
                opener_factory=lambda: bad_readiness,
            )

    def test_acceptance_rejects_empty_or_incomplete_persistence_checks(self):
        for checks in ([], [{"key": "database", "status": "pass"}]):
            opener = FakeOpener([
                FakeResponse(200, {"status": "ok", "timestamp": "2026-10-06T12:00:00.000Z"}),
                FakeResponse(200, {"status": "ok", "token": "opaque-session"}),
                FakeResponse(200, {
                    "status": "ready",
                    "failedCount": 0,
                    "warningCount": 0,
                    "checks": checks,
                }),
            ])
            with self.assertRaises(acceptance.AcceptanceError):
                acceptance.check_acceptance(
                    base_url="http://127.0.0.1:3005",
                    values=VALID_ENV,
                    opener_factory=lambda opener=opener: opener,
                )

    def test_acceptance_rejects_failed_checks_and_inconsistent_ready_status(self):
        mandatory = [
            {"key": "database", "status": "pass"},
            {"key": "token_operation_schema", "status": "pass"},
            {"key": "reward_policy", "status": "pass"},
        ]
        cases = [
            {
                "status": "ready",
                "failedCount": 1,
                "warningCount": 0,
                "checks": mandatory + [{"key": "optional", "status": "fail"}],
            },
            {
                "status": "ready",
                "failedCount": 0,
                "warningCount": 1,
                "checks": mandatory + [{"key": "optional", "status": "warn"}],
            },
            {
                "status": "ready_with_warnings",
                "failedCount": 0,
                "warningCount": 0,
                "checks": mandatory,
            },
        ]
        for readiness in cases:
            opener = FakeOpener([
                FakeResponse(200, {"status": "ok", "timestamp": "2026-10-06T12:00:00.000Z"}),
                FakeResponse(200, {"status": "ok", "token": "opaque-session"}),
                FakeResponse(200, readiness),
            ])
            with self.assertRaises(acceptance.AcceptanceError):
                acceptance.check_acceptance(
                    base_url="http://127.0.0.1:3005",
                    values=VALID_ENV,
                    opener_factory=lambda opener=opener: opener,
                )

    def test_compose_has_immutable_and_operator_owned_inputs(self):
        compose = (ROOT / "compose.production.yaml").read_text(encoding="utf-8")
        self.assertNotIn(":latest", compose)
        self.assertIn("IMAGE_REFERENCE:?", compose)
        self.assertIn("POSTGRES_PASSWORD:?", compose)
        self.assertIn("DATABASE_URL:?", compose)
        self.assertIn("POSTGRES_VOLUME_NAME:?", compose)
        self.assertIn('command: ["node", "dist/api.js"]', compose)
        self.assertIn("/ingest/health", compose)
        self.assertNotIn("POSTGRES_PASSWORD: postgres", compose)

    def test_workflow_separates_main_publish_from_manual_production_dispatch(self):
        workflow = (ROOT / ".github" / "workflows" / "production.yaml").read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("build-and-publish:", workflow)
        self.assertIn("deploy-production:", workflow)
        self.assertIn("github.event_name == 'push'", workflow)
        self.assertIn("github.event_name == 'workflow_dispatch'", workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertIn("name: production", workflow)
        self.assertIn('[[ "$SOURCE_COMMIT" == "$EXPECTED_MAIN_COMMIT" ]]', workflow)
        self.assertIn("org.opencontainers.image.revision=${{ github.sha }}", workflow)
        self.assertIn("git merge-base --is-ancestor", workflow)
        self.assertIn("steps.build.outputs.digest", workflow)
        self.assertIn("GITHUB_STEP_SUMMARY", workflow)
        self.assertNotIn("build-and-deploy:", workflow)
        self.assertNotIn("docker/build-push-action@v6", workflow.split("deploy-production:", 1)[1])

    def test_compose_config_success_and_missing_setting_failure_when_docker_is_available(self):
        docker_candidates = [
            r"C:\Program Files\Docker\Docker\resources\bin\docker.exe",
            shutil.which("docker"),
        ]
        docker = next((candidate for candidate in docker_candidates if candidate and Path(candidate).exists()), None)
        if docker is None:
            self.skipTest("docker is unavailable; text checks still cover the Compose contract")
        with tempfile.TemporaryDirectory() as temp:
            env_path = Path(temp) / ".env"
            values = dict(
                VALID_ENV,
                DEPLOY_ENV_FILE=str(env_path),
                IMAGE_REFERENCE="ghcr.io/zentrixlab/neverflat@sha256:" + "a" * 64,
            )
            env_path.write_text(
                "\n".join(f"{key}={value}" for key, value in values.items()) + "\n",
                encoding="utf-8",
            )
            compose_host_env = {
                key: value for key, value in os.environ.items()
                if key not in (*preflight.COMPOSE_ENV_KEYS, "IMAGE_REFERENCE")
            }
            good = subprocess.run([
                docker, "compose", "--project-name", "neverflat", "--env-file", str(env_path),
                "-f", str(ROOT / "compose.production.yaml"), "config", "--format", "json",
            ], capture_output=True, text=True,
                env=preflight.effective_compose_environment(
                    values, values["IMAGE_REFERENCE"], compose_host_env
                ))
            self.assertEqual(good.returncode, 0, good.stderr)
            preflight.validate_effective_compose_config(
                json.loads(good.stdout), values, values["IMAGE_REFERENCE"]
            )
            env_path.write_text(
                env_path.read_text(encoding="utf-8").replace("POSTGRES_PASSWORD=target-secret\n", ""),
                encoding="utf-8",
            )
            bad = subprocess.run([
                docker, "compose", "--project-name", "neverflat", "--env-file", str(env_path),
                "-f", str(ROOT / "compose.production.yaml"), "config", "--quiet",
            ], capture_output=True, text=True)
            self.assertNotEqual(bad.returncode, 0)

    def _run_deploy_script(self, temp: str, *, mode: str, current_file: bool = False):
        bash_candidates = [r"C:\Program Files\Git\usr\bin\bash.exe", r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash")]
        bash = next((candidate for candidate in bash_candidates if candidate and Path(candidate).exists()), None)
        if bash is None:
            self.skipTest("bash is unavailable; shell rollout checks require Bash")

        root = Path(temp)
        fake_bin = root / "bin"
        fake_bin.mkdir()
        deploy_dir = root / "deploy"
        release_dir = deploy_dir / "releases" / "candidate"
        (release_dir / "scripts").mkdir(parents=True)
        for name in ("compose.production.yaml", "scripts/preflight_production.py", "scripts/check_production_acceptance.py"):
            target = release_dir / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("placeholder\n", encoding="utf-8")
        if mode == "missing-config":
            (release_dir / "compose.production.yaml").unlink()
        deploy_script = release_dir / "scripts/deploy_production.sh"
        shutil.copy2(ROOT / "scripts/deploy_production.sh", deploy_script)
        env_file = deploy_dir / ".env"
        env_file.write_text("COMPOSE_PROJECT_NAME=neverflat\n", encoding="utf-8")
        deploy_dir.mkdir(exist_ok=True)
        if current_file:
            (deploy_dir / "current").write_text("regular file\n", encoding="utf-8")

        log = root / "calls.log"
        state = root / "container-state"
        image = "ghcr.io/zentrixlab/neverflat@sha256:" + "b" * 64
        old_image = "ghcr.io/zentrixlab/neverflat@sha256:" + "c" * 64
        initial_status = "running" if mode == "live-app" else "stopped"
        initial_health = "healthy" if mode == "live-app" else "none"
        state.write_text(f"old-app-id|{old_image}|{initial_status}|{initial_health}\n", encoding="utf-8")
        shell_tools = {
            "flock": """
                #!/usr/bin/env bash
                printf 'flock %s\\n' "$*" >> "$FAKE_LOG"
                exit 0
            """,
            "ln": """
                #!/usr/bin/env bash
                printf 'ln %s\\n' "$*" >> "$FAKE_LOG"
                exit 0
            """,
            "python3": """
                #!/usr/bin/env bash
                printf 'python %s\\n' "$*" >> "$FAKE_LOG"
                case "${1:-}" in
                  */preflight_production.py)
                    preflight_count=0
                    [[ -f "$FAKE_PREFLIGHT_COUNT" ]] && preflight_count=$(cat "$FAKE_PREFLIGHT_COUNT")
                    preflight_count=$((preflight_count + 1))
                    printf '%s\\n' "$preflight_count" > "$FAKE_PREFLIGHT_COUNT"
                    if [[ "${FAKE_PREFLIGHT:-success}" == "fail" ]]; then
                      printf 'preflight rejected target release gate\\n' >&2
                      exit 1
                    fi
                    if [[ "${FAKE_SECOND_PREFLIGHT:-success}" == "fail" && "$preflight_count" -ge 2 ]]; then
                      printf 'preflight rejected refreshed target gate\\n' >&2
                      exit 1
                    fi
                    ;;
                  -)
                    printf 'neverflat\\n'
                    ;;
                  */check_production_acceptance.py)
                    [[ "${FAKE_ACCEPTANCE:-fail}" == "success" ]]
                    exit $?
                    ;;
                esac
                exit 0
            """,
            "docker": """
                #!/usr/bin/env bash
                printf 'docker %s\\n' "$*" >> "$FAKE_LOG"
                state_file="$FAKE_STATE"
                read_state() {
                  IFS='|' read -r app_id app_image app_status app_health < "$state_file"
                }
                write_state() {
                  printf '%s|%s|%s|%s\\n' "$1" "$2" "$3" "$4" > "$state_file"
                }
                case "${1:-}" in
                  login) exit 0 ;;
                  network)
                    [[ "${2:-}" == "inspect" ]] && exit 1
                    exit 0
                    ;;
                  image)
                    if [[ "${2:-}" == "inspect" ]]; then
                      printf '%s\\n' "${FAKE_IMAGE_REVISION:-}"
                    fi
                    exit 0
                    ;;
                  compose)
                    if [[ "$*" == *" pull app"* ]]; then
                      if [[ "${FAKE_COMPOSE_MODE:-success}" == "app-live-after-pull" ]]; then
                        read_state
                        write_state "$app_id" "$app_image" running healthy
                      fi
                      exit 0
                    fi
                    if [[ "$*" == *" up -d --no-deps app"* ]]; then
                      read_state
                      new_image="$IMAGE_REFERENCE"
                      [[ "${FAKE_COMPOSE_MODE:-success}" == "image-mismatch" ]] && new_image="ghcr.io/zentrixlab/neverflat@sha256:$(printf 'd%.0s' {1..64})"
                      new_health="healthy"
                      [[ "${FAKE_COMPOSE_MODE:-success}" == "unhealthy" ]] && new_health="unhealthy"
                      new_app_id="new-app-id"
                      [[ "${FAKE_COMPOSE_MODE:-success}" == "same-id-readiness-failure" || "${FAKE_COMPOSE_MODE:-success}" == "same-id-up-partial-failure" ]] && new_app_id="old-app-id"
                      write_state "$new_app_id" "$new_image" running "$new_health"
                      [[ "${FAKE_COMPOSE_MODE:-success}" == "up-partial-failure" ]] && exit 1
                      [[ "${FAKE_COMPOSE_MODE:-success}" == "same-id-up-partial-failure" ]] && exit 1
                    fi
                    exit 0
                    ;;
                  inspect)
                    read_state
                    if [[ "${FAKE_COMPOSE_MODE:-success}" == "inspect-failure" && "$app_id" == "new-app-id" && "$*" == *State.Status* ]]; then
                      printf 'Error: daemon unavailable\\n' >&2
                      exit 1
                    elif [[ "$*" == *Config.Image* ]]; then
                      printf '%s\\n' "$app_image"
                    elif [[ "$*" == *"{{.Id}}|{{.State.Status}}"* ]]; then
                      printf '%s|%s\\n' "$app_id" "$app_status"
                    elif [[ "$*" == *"{{.Id}}"* ]]; then
                      printf '%s\\n' "$app_id"
                    elif [[ "$*" == *State.Status* ]]; then
                      if [[ "${FAKE_COMPOSE_MODE:-success}" == "interrupt" && ! -f "${FAKE_STATE}.interrupt" ]]; then
                        : > "${FAKE_STATE}.interrupt"
                        kill -INT "$PPID"
                      fi
                      printf '%s|%s\\n' "$app_status" "$app_health"
                    else
                      printf '%s|%s\\n' "$app_status" "$app_health"
                    fi
                    exit 0
                    ;;
                  stop)
                    if [[ "${FAKE_COMPOSE_MODE:-success}" == "stop-failure" ]]; then
                      exit 1
                    fi
                    read_state
                    write_state "$app_id" "$app_image" stopped none
                    exit 0
                    ;;
                esac
                exit 0
            """,
        }
        for name, content in shell_tools.items():
            tool = fake_bin / name
            tool.write_text(textwrap.dedent(content).lstrip(), encoding="utf-8")
            tool.chmod(0o755)

        env = os.environ.copy()
        env.update({
            "PATH": os.pathsep.join([
                str(fake_bin),
                r"C:\Program Files\Git\usr\bin",
                r"C:\Program Files\Git\bin",
                env.get("PATH", ""),
            ]),
            "FAKE_LOG": str(log),
            "FAKE_STATE": str(state),
            "FAKE_PREFLIGHT_COUNT": str(root / "preflight-count"),
            "DEPLOY_DIR": str(deploy_dir),
            "RELEASE_DIR": str(release_dir),
            "ENV_FILE": str(env_file),
            "IMAGE_REFERENCE": image,
            "SOURCE_COMMIT": SOURCE_COMMIT,
            "APPROVAL_RECORD": str(deploy_dir / "approvals" / f"{SOURCE_COMMIT}.json"),
            "FAKE_IMAGE_REVISION": "2" * 40 if mode == "image-revision-mismatch" else ("" if mode == "image-revision-missing" else SOURCE_COMMIT),
            "GHCR_USER": "operator",
            "GHCR_TOKEN": "opaque-token",
            "STARTUP_TIMEOUT_SECONDS": "1",
            "STARTUP_INTERVAL_SECONDS": "0",
            "FAKE_PREFLIGHT": "fail" if mode in {
                "changed-volume", "gate-bypass", "malformed-gate", "stale-gate", "missing-gate", "live-app",
            } else "success",
            "FAKE_SECOND_PREFLIGHT": "fail" if mode in {"expired-after-pull", "app-live-after-pull"} else "success",
            "FAKE_ACCEPTANCE": "success" if mode == "success" else "fail",
            "FAKE_COMPOSE_MODE": mode,
        })
        if mode in {
            "up-partial-failure", "image-mismatch", "unhealthy", "readiness-failure", "interrupt", "stop-failure",
            "same-id-readiness-failure", "same-id-up-partial-failure", "inspect-failure",
            "image-revision-mismatch", "image-revision-missing",
            "expired-after-pull", "app-live-after-pull",
        }:
            (deploy_dir / ".deployed-image").write_text(old_image + "\n", encoding="utf-8")
            old_release = deploy_dir / "releases" / "old"
            old_release.mkdir()
            os.symlink(old_release, deploy_dir / "current", target_is_directory=True)
        result = subprocess.run(
            [bash, str(deploy_script)],
            cwd=str(ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )
        return result, deploy_dir, log, state, image, old_image

    def test_deploy_script_success_uses_exact_digest_and_orders_mutations(self):
        with tempfile.TemporaryDirectory() as temp:
            result, deploy_dir, log, state, image, _old_image = self._run_deploy_script(temp, mode="success")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((deploy_dir / ".deployed-image").read_text(encoding="utf-8").strip(), image)
            self.assertEqual(state.read_text(encoding="utf-8").strip().split("|")[2:4], ["running", "healthy"])
            calls = log.read_text(encoding="utf-8").splitlines()
            preflight_index = next(index for index, line in enumerate(calls) if "preflight_production.py" in line)
            login_index = next(index for index, line in enumerate(calls) if "docker login" in line)
            network_index = next(index for index, line in enumerate(calls) if "docker network create" in line)
            compose_index = next(index for index, line in enumerate(calls) if "docker compose" in line)
            revision_index = next(index for index, line in enumerate(calls) if "docker image inspect" in line)
            up_index = next(index for index, line in enumerate(calls) if "up -d --no-deps app" in line)
            image_index = next(index for index, line in enumerate(calls) if "Config.Image" in line)
            state_index = next(index for index, line in enumerate(calls) if "State.Status" in line)
            acceptance_index = next(index for index, line in enumerate(calls) if "check_production_acceptance.py" in line)
            link_index = next(index for index, line in enumerate(calls) if line.startswith("ln -sfn"))
            self.assertLess(preflight_index, login_index)
            self.assertLess(login_index, network_index)
            self.assertLess(network_index, compose_index)
            self.assertLess(revision_index, up_index)
            self.assertLess(image_index, state_index)
            self.assertLess(state_index, acceptance_index)
            self.assertLess(acceptance_index, link_index)
            self.assertIn("up -d --no-deps app", "\n".join(calls))
            self.assertNotIn("--remove-orphans", "\n".join(calls))
            self.assertFalse(any("stop " in line for line in calls))

    def test_deploy_script_stops_before_mutation_for_missing_or_changed_configuration(self):
        with tempfile.TemporaryDirectory() as temp:
            result, deploy_dir, log, state, _image, _old_image = self._run_deploy_script(temp, mode="changed-volume")
            self.assertNotEqual(result.returncode, 0)
            calls = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
            self.assertFalse(any(line.startswith("docker ") for line in calls))
            self.assertFalse((deploy_dir / ".deployed-image").exists())
            self.assertEqual(state.read_text(encoding="utf-8").strip().split("|")[0], "old-app-id")

        with tempfile.TemporaryDirectory() as temp:
            result, deploy_dir, log, _state, _image, _old_image = self._run_deploy_script(temp, mode="missing-config")
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(log.exists() and log.read_text(encoding="utf-8").strip())

    def test_deploy_script_rejects_gate_bypass_malformed_and_stale_records_before_docker(self):
        for mode in ("gate-bypass", "malformed-gate", "stale-gate", "missing-gate", "live-app"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                result, _deploy_dir, log, state, _image, _old_image = self._run_deploy_script(temp, mode=mode)
                self.assertNotEqual(result.returncode, 0)
                calls = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
                self.assertFalse(any(line.startswith("docker ") for line in calls))
                state_fields = state.read_text(encoding="utf-8").strip().split("|")
                self.assertEqual(state_fields[0], "old-app-id")
                self.assertEqual(state_fields[2:], ["running", "healthy"] if mode == "live-app" else ["stopped", "none"])

    def test_deploy_script_stops_before_docker_for_non_symlink_current_path(self):
        with tempfile.TemporaryDirectory() as temp:
            result, deploy_dir, log, state, _image, _old_image = self._run_deploy_script(temp, mode="success", current_file=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not a symlink", result.stderr)
            self.assertFalse(log.exists() and log.read_text(encoding="utf-8").strip())
            self.assertTrue((deploy_dir / "current").is_file())
            self.assertEqual(state.read_text(encoding="utf-8").strip().split("|")[0], "old-app-id")

    def test_deploy_script_stops_only_rejected_app_and_preserves_accepted_pointer(self):
        for mode in (
            "up-partial-failure", "image-mismatch", "unhealthy", "readiness-failure", "interrupt",
            "same-id-readiness-failure", "same-id-up-partial-failure",
        ):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                result, deploy_dir, log, state, _image, old_image = self._run_deploy_script(temp, mode=mode)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertEqual(
                    (deploy_dir / ".deployed-image").read_text(encoding="utf-8"),
                    old_image + "\n",
                )
                self.assertFalse((deploy_dir / ".previous-image").exists())
                self.assertTrue((deploy_dir / "current").is_symlink())
                self.assertEqual(Path(os.readlink(deploy_dir / "current")).name, "old")
                state_fields = state.read_text(encoding="utf-8").strip().split("|")
                expected_id = "old-app-id" if mode.startswith("same-id-") else "new-app-id"
                self.assertEqual(state_fields[0], expected_id)
                self.assertEqual(state_fields[2:], ["stopped", "none"])
                calls = log.read_text(encoding="utf-8").splitlines()
                self.assertTrue(any(line.startswith(f"docker stop --time 10 {expected_id}") for line in calls))
                self.assertFalse(any(" compose down" in line for line in calls))
                self.assertFalse(any(line.startswith("docker stop neverflat-db") for line in calls))

    def test_deploy_script_rejects_missing_or_mismatched_image_revision_before_launch(self):
        for mode in ("image-revision-missing", "image-revision-mismatch"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                result, deploy_dir, log, state, _image, old_image = self._run_deploy_script(temp, mode=mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("image revision", result.stderr)
                self.assertEqual((deploy_dir / ".deployed-image").read_text(encoding="utf-8"), old_image + "\n")
                self.assertEqual(state.read_text(encoding="utf-8").strip().split("|")[2:], ["stopped", "none"])
                calls = log.read_text(encoding="utf-8").splitlines()
                self.assertTrue(any(line.startswith("docker image inspect") for line in calls))
                self.assertFalse(any(" compose up " in line for line in calls))
                self.assertFalse(any(line.startswith("docker stop ") for line in calls))

    def test_deploy_script_revalidates_gate_and_app_state_before_launch(self):
        for mode, expected_state in (
            ("expired-after-pull", ["stopped", "none"]),
            ("app-live-after-pull", ["running", "healthy"]),
        ):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                result, deploy_dir, log, state, _image, old_image = self._run_deploy_script(temp, mode=mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("preflight rejected refreshed target gate", result.stderr)
                self.assertEqual((deploy_dir / ".deployed-image").read_text(encoding="utf-8"), old_image + "\n")
                self.assertEqual(state.read_text(encoding="utf-8").strip().split("|")[2:], expected_state)
                calls = log.read_text(encoding="utf-8").splitlines()
                self.assertEqual(
                    sum("preflight_production.py" in line and not line.startswith("python -") for line in calls),
                    2,
                )
                self.assertFalse(any(" compose up " in line for line in calls))
                self.assertFalse(any(line.startswith("docker stop ") for line in calls))

    def test_deploy_script_reports_inspection_failure_as_incomplete_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            result, deploy_dir, log, state, _image, old_image = self._run_deploy_script(temp, mode="inspect-failure")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("cleanup was incomplete", result.stderr)
            self.assertEqual((deploy_dir / ".deployed-image").read_text(encoding="utf-8"), old_image + "\n")
            self.assertEqual(state.read_text(encoding="utf-8").strip().split("|")[2:], ["running", "healthy"])
            calls = log.read_text(encoding="utf-8").splitlines()
            self.assertFalse(any(line.startswith("docker stop ") for line in calls))

    def test_deploy_script_reports_cleanup_failure_and_leaves_rejected_app_visible(self):
        with tempfile.TemporaryDirectory() as temp:
            result, _deploy_dir, log, state, _image, _old_image = self._run_deploy_script(temp, mode="stop-failure")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("cleanup was incomplete", result.stderr)
            self.assertEqual(state.read_text(encoding="utf-8").strip().split("|")[2:], ["running", "healthy"])
            self.assertTrue(any(line.startswith("docker stop --time 10 new-app-id") for line in log.read_text(encoding="utf-8").splitlines()))


if __name__ == "__main__":
    unittest.main()
