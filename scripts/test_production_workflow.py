#!/usr/bin/env python3
"""Offline behavior checks for the automatic Neverflat deployment workflow."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "production.yaml"


def bash_path() -> str:
    candidates = (
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files\Git\bin\bash.exe",
        shutil.which("bash"),
    )
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    raise unittest.SkipTest("bash is unavailable")


def extract_workflow_script(workflow: str, step_name: str) -> str:
    lines = workflow.splitlines()
    marker = f"- name: {step_name}"
    try:
        step_start = next(index for index, line in enumerate(lines) if line.strip() == marker)
        script_index = next(
            index
            for index in range(step_start + 1, len(lines))
            if lines[index].strip() == "script: |"
        )
    except StopIteration as exc:
        raise AssertionError(f"workflow step {step_name!r} has no script block") from exc

    content_indent = len(lines[script_index + 1]) - len(lines[script_index + 1].lstrip())
    content: list[str] = []
    for line in lines[script_index + 1 :]:
        if line and len(line) - len(line.lstrip()) < content_indent:
            break
        content.append(line[content_indent:] if line else "")
    return "\n".join(content) + "\n"


def bash_native_path(path: Path, bash: str) -> str:
    result = subprocess.run(
        [bash, "-lc", "cygpath -u \"$1\"", "bash", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def test_script_for_target(script: str, target: Path, bash: str) -> str:
    del bash
    # Keep the production checks intact while making the fixed target injectable
    # for an offline fixture. The production value remains /root/neverflat.
    return (
        script
        .replace('DEPLOY_DIR=/root/neverflat', 'DEPLOY_DIR="${TEST_NEVERFLAT:?}"')
        .replace('== "/root/neverflat"', '== "$DEPLOY_DIR"')
    )


def write_fake_docker(directory: Path) -> None:
    (directory / "docker").write_text(
        textwrap.dedent(
            r"""
            #!/usr/bin/env bash
            set -euo pipefail
            printf 'docker %s\n' "$*" >> "$FAKE_LOG"
            mode="${FAKE_MODE:-success}"
            if [[ "${1:-}" == "inspect" && "${2:-}" == "neverflat-db" ]]; then
              if [[ "$mode" == "wrong-db" ]]; then
                printf 'other|postgres\n'
              else
                printf 'neverflat|postgres\n'
              fi
              exit 0
            fi
            if [[ "${1:-}" == "inspect" && "${2:-}" == "neverflat-app" ]]; then
              if [[ "$mode" == "missing-app" ]]; then
                printf 'Error: No such object: neverflat-app\n' >&2
                exit 1
              elif [[ "$mode" == "wrong-app" ]]; then
                printf 'other|app\n'
              else
                printf 'neverflat|app\n'
              fi
              exit 0
            fi
            if [[ "${1:-}" == "network" && "${2:-}" == "inspect" ]]; then
              [[ "$mode" != "missing-network" ]]
              exit $?
            fi
            if [[ "${1:-}" == "compose" && "$*" == *"version"* ]]; then
              printf 'Docker Compose version v2.30.0\n'
              exit 0
            fi
            if [[ "${1:-}" == "exec" && "$*" == *"pg_dump"* ]]; then
              printf 'mock-neverflat-dump\n'
              exit 0
            fi
            if [[ "${1:-}" == "exec" && "$*" == *"pg_restore"* ]]; then
              exit 0
            fi
            if [[ "${1:-}" == "login" ]]; then
              exit 0
            fi
            if [[ "${1:-}" == "compose" ]]; then
              exit 0
            fi
            exit 0
            """
        ).lstrip(),
        encoding="utf-8",
    )
    (directory / "docker").chmod(0o755)


def write_fake_python(directory: Path) -> None:
    (directory / "python3").write_text(
        textwrap.dedent(
            r"""
            #!/usr/bin/env bash
            cat >/dev/null
            printf 'python3 %s\n' "$*" >> "$FAKE_LOG"
            """
        ).lstrip(),
        encoding="utf-8",
    )
    (directory / "python3").chmod(0o755)
    (directory / "curl").write_text(
        textwrap.dedent(
            r"""
            #!/usr/bin/env bash
            [[ "${FAKE_MODE:-success}" != "health-failure" ]]
            """
        ).lstrip(),
        encoding="utf-8",
    )
    (directory / "curl").chmod(0o755)


class AutomaticWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")
        cls.pre_stage_script = extract_workflow_script(cls.workflow, "Verify NEVERFLAT target before staging")
        cls.deploy_script = extract_workflow_script(cls.workflow, "Deploy to server")

    def test_workflow_forwards_explicit_source_commit_and_restores_from_stdin(self):
        self.assertIn("SOURCE_COMMIT: ${{ github.sha }}", self.workflow)
        self.assertIn("GHCR_TOKEN,SOURCE_COMMIT", self.workflow)
        self.assertIn('backup_dir/nvf_award_${SOURCE_COMMIT}.XXXXXX.dump', self.deploy_script)
        self.assertIn('pg_restore --list < "$backup_file"', self.deploy_script)
        self.assertNotIn("${GITHUB_SHA}", self.deploy_script)

    def run_workflow_script(self, script: str, root: Path, mode: str = "success") -> tuple[subprocess.CompletedProcess[str], Path]:
        bash = bash_path()
        target = root / "neverflat"
        target.mkdir(parents=True)
        (target / ".env").write_text("EXISTING_SETTING=preserved\n", encoding="utf-8")
        (target / "compose.production.yaml").write_text("services: {}\n", encoding="utf-8")
        (target / "docker-compose.yaml").write_text("sentinel\n", encoding="utf-8")
        if mode == "env-escape":
            outside_env = root / "outside.env"
            outside_env.write_text("OUTSIDE=must-not-be-read\n", encoding="utf-8")
            (target / ".env").unlink()
            os.symlink(outside_env, target / ".env")
        fake_bin = root / "bin"
        fake_bin.mkdir()
        write_fake_docker(fake_bin)
        write_fake_python(fake_bin)
        script_path = root / "workflow.sh"
        rendered_script = test_script_for_target(script, target, bash)
        if mode == "health-failure":
            rendered_script = rendered_script.replace("seq 1 24", "seq 1 2").replace("sleep 5", "sleep 0")
        script_path.write_text(rendered_script, encoding="utf-8")

        log = root / "calls.log"
        env = os.environ.copy()
        env.pop("GITHUB_SHA", None)
        env.update(
            {
                "TEST_NEVERFLAT": bash_native_path(target, bash),
                "FAKE_LOG": str(log),
                "FAKE_MODE": mode,
                "SOURCE_COMMIT": "1" * 40,
                "ADMIN_EMAIL": "admin@example.com",
                "ADMIN_PASSWORD": "admin-secret",
                "BEIA_API_KEY": "api-secret",
                "BEIA_ADMIN_EMAIL": "beia@example.com",
                "BEIA_ADMIN_PASSWORD": "beia-secret",
                "GHCR_USER": "github-actions",
                "GHCR_TOKEN": "opaque-token",
                "PATH": os.pathsep.join(
                    [str(fake_bin), r"C:\Program Files\Git\usr\bin", env.get("PATH", "")]
                ),
            }
        )
        if mode == "missing-source-commit":
            env.pop("SOURCE_COMMIT", None)
        elif mode == "invalid-source-commit":
            env["SOURCE_COMMIT"] = "not-a-full-sha"
        result = subprocess.run(
            [bash, str(script_path)],
            cwd=str(ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return result, target

    def test_pre_stage_guard_rejects_wrong_db_app_and_compose_symlink_before_mutation(self):
        for mode in ("wrong-db", "wrong-app"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                result, target = self.run_workflow_script(self.pre_stage_script, Path(temp), mode)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                calls = (Path(temp) / "calls.log").read_text(encoding="utf-8")
                self.assertNotIn("network create", calls)
                self.assertNotIn("login", calls)
                self.assertTrue((target / ".env").exists())

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / "neverflat"
            target.mkdir()
            (target / ".env").write_text("EXISTING_SETTING=preserved\n", encoding="utf-8")
            outside = root / "outside-compose.yaml"
            outside.write_text("services: {}\n", encoding="utf-8")
            os.unlink(target / "compose.production.yaml") if (target / "compose.production.yaml").exists() else None
            os.symlink(outside, target / "compose.production.yaml")
            bash = bash_path()
            fake_bin = root / "bin"
            fake_bin.mkdir()
            write_fake_docker(fake_bin)
            script_path = root / "workflow.sh"
            script_path.write_text(test_script_for_target(self.pre_stage_script, target, bash), encoding="utf-8")
            log = root / "calls.log"
            env = os.environ.copy()
            env.update(
                {
                    "TEST_NEVERFLAT": bash_native_path(target, bash),
                    "FAKE_LOG": str(log),
                    "FAKE_MODE": "success",
                    "PATH": os.pathsep.join([str(fake_bin), r"C:\Program Files\Git\usr\bin", env.get("PATH", "")]),
                }
            )
            result = subprocess.run([bash, str(script_path)], cwd=str(ROOT), env=env, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertFalse(log.exists() and "inspect" in log.read_text(encoding="utf-8"))

    def test_deploy_script_backups_before_app_launch_and_cleans_owned_docker_config(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            result, target = self.run_workflow_script(self.deploy_script, root)
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = (root / "calls.log").read_text(encoding="utf-8").splitlines()
            backup_files = list((target / "backups").glob("*.dump"))
            self.assertEqual(len(backup_files), 1)
            self.assertEqual(backup_files[0].read_text(encoding="utf-8"), "mock-neverflat-dump\n")
            self.assertIn("nvf_award_" + "1" * 40, backup_files[0].name)
            dump_index = next(index for index, line in enumerate(calls) if "pg_dump" in line)
            restore_index = next(index for index, line in enumerate(calls) if "pg_restore" in line)
            login_index = next(index for index, line in enumerate(calls) if " login " in f" {line} ")
            pull_index = next(index for index, line in enumerate(calls) if "pull app" in line)
            up_index = next(index for index, line in enumerate(calls) if "up -d --no-deps app" in line)
            self.assertLess(dump_index, restore_index)
            self.assertLess(restore_index, login_index)
            self.assertLess(login_index, pull_index)
            self.assertLess(pull_index, up_index)
            self.assertTrue(any("pg_restore --list" in line and "pg_restore --list -" not in line for line in calls))
            self.assertNotIn("network create", "\n".join(calls))
            self.assertNotIn("--remove-orphans", "\n".join(calls))
            self.assertTrue(any(line.startswith("docker compose") and "up -d --no-deps app" in line for line in calls))
            self.assertEqual(list(target.glob(".docker-config.*")), [])

    def test_deploy_script_rejects_wrong_db_before_backup_or_login(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            result, target = self.run_workflow_script(self.deploy_script, root, mode="wrong-db")
            self.assertNotEqual(result.returncode, 0)
            calls = (root / "calls.log").read_text(encoding="utf-8")
            self.assertNotIn("pg_dump", calls)
            self.assertNotIn(" login ", f" {calls} ")
            self.assertFalse((target / "backups").exists())
            self.assertTrue((target / "docker-compose.yaml").exists())

    def test_deploy_script_requires_explicit_forwarded_source_commit_before_mutation(self):
        for mode in ("missing-source-commit", "invalid-source-commit"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                result, target = self.run_workflow_script(self.deploy_script, root, mode=mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("SOURCE_COMMIT must be a full source commit SHA", result.stderr)
                calls = (root / "calls.log").read_text(encoding="utf-8") if (root / "calls.log").exists() else ""
                self.assertNotIn("pg_dump", calls)
                self.assertNotIn(" login ", f" {calls} ")
                self.assertTrue((target / "docker-compose.yaml").exists())

    def test_deploy_script_rechecks_app_and_env_before_mutation(self):
        for mode in ("wrong-app", "env-escape"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                result, target = self.run_workflow_script(self.deploy_script, root, mode=mode)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                calls = (root / "calls.log").read_text(encoding="utf-8") if (root / "calls.log").exists() else ""
                self.assertNotIn("pg_dump", calls)
                self.assertNotIn(" login ", f" {calls} ")
                self.assertTrue((target / "docker-compose.yaml").exists())
                self.assertFalse((target / "backups").exists())

    def test_deploy_script_fails_clearly_when_loopback_health_never_recovers(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            result, target = self.run_workflow_script(self.deploy_script, root, mode="health-failure")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("/ingest/health did not become ready", result.stderr)
            self.assertTrue(list((target / "backups").glob("*.dump")))
            self.assertEqual(list(target.glob(".docker-config.*")), [])


if __name__ == "__main__":
    unittest.main()
