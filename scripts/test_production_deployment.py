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
from pathlib import Path


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
            "Config": {
                "Labels": {"com.docker.compose.project": "neverflat"},
                "Env": ["POSTGRES_DB=nvf_award", "POSTGRES_USER=postgres", "POSTGRES_PASSWORD=other"],
            },
            "Mounts": [{"Type": "volume", "Name": "other_volume", "Destination": "/var/lib/postgresql/data"}],
        }
        with self.assertRaises(preflight.PreflightError):
            preflight.validate_database_snapshot(snapshot, values)

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
        self.assertIn("/ingest/health", compose)
        self.assertNotIn("POSTGRES_PASSWORD: postgres", compose)

    def test_compose_config_success_and_missing_setting_failure_when_docker_is_available(self):
        if shutil.which("docker") is None:
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
                "docker", "compose", "--project-name", "neverflat", "--env-file", str(env_path),
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
                "docker", "compose", "--project-name", "neverflat", "--env-file", str(env_path),
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
        image = "ghcr.io/zentrixlab/neverflat@sha256:" + "b" * 64
        shell_tools = {
            "flock": """
                #!/usr/bin/env bash
                printf 'flock %s\\n' \"$*\" >> \"$FAKE_LOG\"
                exit 0
            """,
            "ln": """
                #!/usr/bin/env bash
                printf 'ln %s\\n' \"$*\" >> \"$FAKE_LOG\"
                exit 0
            """,
            "python3": """
                #!/usr/bin/env bash
                printf 'python %s\\n' \"$*\" >> \"$FAKE_LOG\"
                case \"${1:-}\" in
                  */preflight_production.py)
                    if [[ \"${FAKE_PREFLIGHT:-success}\" == \"fail\" ]]; then
                      printf 'preflight rejected changed volume\\n' >&2
                      exit 1
                    fi
                    ;;
                  -)
                    printf 'neverflat\\n'
                    ;;
                  */check_production_acceptance.py)
                    [[ \"${FAKE_ACCEPTANCE:-fail}\" == \"success\" ]]
                    exit $?
                    ;;
                esac
                exit 0
            """,
            "docker": """
                #!/usr/bin/env bash
                printf 'docker %s\\n' \"$*\" >> \"$FAKE_LOG\"
                case \"${1:-}\" in
                  login) exit 0 ;;
                  network)
                    [[ \"${2:-}\" == \"inspect\" ]] && exit 1
                    exit 0
                    ;;
                  compose) exit 0 ;;
                  inspect)
                    if [[ \"$*\" == *Config.Image* ]]; then
                      printf '%s\\n' \"$IMAGE_REFERENCE\"
                    else
                      printf 'running|healthy\\n'
                    fi
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
            "DEPLOY_DIR": str(deploy_dir),
            "RELEASE_DIR": str(release_dir),
            "ENV_FILE": str(env_file),
            "IMAGE_REFERENCE": image,
            "GHCR_USER": "operator",
            "GHCR_TOKEN": "opaque-token",
            "STARTUP_TIMEOUT_SECONDS": "1",
            "STARTUP_INTERVAL_SECONDS": "0",
            "FAKE_PREFLIGHT": "fail" if mode == "changed-volume" else "success",
            "FAKE_ACCEPTANCE": "success" if mode == "success" else "fail",
        })
        if mode == "startup-failure":
            (deploy_dir / ".deployed-image").write_text("ghcr.io/zentrixlab/neverflat@sha256:" + "c" * 64 + "\n", encoding="utf-8")
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
        return result, deploy_dir, log, image

    def test_deploy_script_success_uses_exact_digest_and_orders_mutations(self):
        with tempfile.TemporaryDirectory() as temp:
            result, deploy_dir, log, image = self._run_deploy_script(temp, mode="success")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((deploy_dir / ".deployed-image").read_text(encoding="utf-8").strip(), image)
            calls = log.read_text(encoding="utf-8").splitlines()
            preflight_index = next(index for index, line in enumerate(calls) if "preflight_production.py" in line)
            login_index = next(index for index, line in enumerate(calls) if "docker login" in line)
            network_index = next(index for index, line in enumerate(calls) if "docker network create" in line)
            compose_index = next(index for index, line in enumerate(calls) if "docker compose" in line)
            image_index = next(index for index, line in enumerate(calls) if "Config.Image" in line)
            state_index = next(index for index, line in enumerate(calls) if "State.Status" in line)
            acceptance_index = next(index for index, line in enumerate(calls) if "check_production_acceptance.py" in line)
            link_index = next(index for index, line in enumerate(calls) if line.startswith("ln -sfn"))
            self.assertLess(preflight_index, login_index)
            self.assertLess(login_index, network_index)
            self.assertLess(network_index, compose_index)
            self.assertLess(image_index, state_index)
            self.assertLess(state_index, acceptance_index)
            self.assertLess(acceptance_index, link_index)

    def test_deploy_script_stops_before_mutation_for_missing_or_changed_configuration(self):
        with tempfile.TemporaryDirectory() as temp:
            result, deploy_dir, log, _ = self._run_deploy_script(temp, mode="changed-volume")
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(any(line.startswith("docker ") for line in log.read_text(encoding="utf-8").splitlines()))
            self.assertFalse((deploy_dir / ".deployed-image").exists())

        with tempfile.TemporaryDirectory() as temp:
            result, deploy_dir, log, _ = self._run_deploy_script(temp, mode="missing-config")
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(log.exists() and log.read_text(encoding="utf-8").strip())

    def test_deploy_script_stops_before_docker_for_non_symlink_current_path(self):
        with tempfile.TemporaryDirectory() as temp:
            result, deploy_dir, log, _ = self._run_deploy_script(temp, mode="success", current_file=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not a symlink", result.stderr)
            self.assertFalse(log.exists() and log.read_text(encoding="utf-8").strip())
            self.assertTrue((deploy_dir / "current").is_file())

    def test_deploy_script_startup_failure_preserves_existing_release_record(self):
        with tempfile.TemporaryDirectory() as temp:
            result, deploy_dir, log, _ = self._run_deploy_script(temp, mode="startup-failure")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(
                (deploy_dir / ".deployed-image").read_text(encoding="utf-8"),
                "ghcr.io/zentrixlab/neverflat@sha256:" + "c" * 64 + "\n",
            )
            self.assertFalse((deploy_dir / ".previous-image").exists())
            self.assertTrue((deploy_dir / "current").is_symlink())
            self.assertEqual(Path(os.readlink(deploy_dir / "current")).name, "old")
            self.assertNotIn("ln -sfn", log.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
