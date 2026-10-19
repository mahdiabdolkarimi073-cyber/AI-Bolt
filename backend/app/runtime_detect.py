"""Phase 10 — runtime & framework detection.

Detects a project's technology by inspecting real manifest/config files and
checking which runtimes are installed on the host. Detection is best-effort and
honest: when a tool is missing, we say so and suggest an install command
(without running it).

Adapters are registered in `RUNTIME_ADAPTERS` so new languages/frameworks can
be added without touching the detection core or the execution engine.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from app.execution import detect_tool


@dataclass
class DetectedRuntime:
    runtime: str = "unknown"
    language: Optional[str] = None
    framework: Optional[str] = None
    package_manager: Optional[str] = None
    manifest: Optional[str] = None
    details: dict = field(default_factory=dict)
    available_tools: dict[str, bool] = field(default_factory=dict)
    missing_tools: list[str] = field(default_factory=list)
    install_hint: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "runtime": self.runtime,
            "language": self.language,
            "framework": self.framework,
            "packageManager": self.package_manager,
            "manifest": self.manifest,
            "details": self.details,
            "availableTools": self.available_tools,
            "missingTools": self.missing_tools,
            "installHint": self.install_hint,
        }


@dataclass
class InferredCommand:
    """A command inferred from project manifests. `approved` is False by
    default — the UI must get user approval before running any sensitive one."""
    action: str
    command: Optional[str]
    kind: str = "command"          # command|run|test|build|typecheck|lint|deps|preview
    long_running: bool = False
    reason: str = ""
    sensitive: bool = False        # deps installs, destructive ops
    available: bool = True
    missing_tool: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "action": self.action,
            "command": self.command,
            "kind": self.kind,
            "longRunning": self.long_running,
            "reason": self.reason,
            "sensitive": self.sensitive,
            "available": self.available,
            "missingTool": self.missing_tool,
        }


# --- Adapter protocol (duck-typed) ---


class RuntimeAdapter:
    """Base adapter. Subclasses override `detect` and `infer_commands`."""
    name = "base"

    def detect(self, root: Path) -> Optional[DetectedRuntime]:
        raise NotImplementedError

    def infer_commands(self, root: Path, runtime: DetectedRuntime) -> list[InferredCommand]:
        raise NotImplementedError


# --- Node.js / TypeScript family ---


class NodeAdapter(RuntimeAdapter):
    name = "node"

    def detect(self, root: Path) -> Optional[DetectedRuntime]:
        pkg = root / "package.json"
        if not pkg.is_file():
            return None
        try:
            data = json.loads(pkg.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
        scripts = data.get("scripts", {}) if isinstance(data, dict) else {}
        deps = data.get("dependencies", {}) if isinstance(data, dict) else {}
        dev_deps = data.get("devDependencies", {}) if isinstance(data, dict) else {}
        all_deps = {**deps, **dev_deps}

        framework = None
        if "next" in all_deps:
            framework = "next"
        elif "nest" in all_deps or "@nestjs/core" in all_deps:
            framework = "nest"
        elif "express" in all_deps or "fastify" in all_deps:
            framework = "express"
        elif "vite" in all_deps or "vite" in dev_deps:
            framework = "vite"
        elif "react" in all_deps:
            framework = "react"

        language = "typescript" if (root / "tsconfig.json").exists() else "javascript"

        # Prefer the package manager implied by the lockfile.
        pm = None
        if (root / "pnpm-lock.yaml").exists() and detect_tool("pnpm"):
            pm = "pnpm"
        elif (root / "yarn.lock").exists() and detect_tool("yarn"):
            pm = "yarn"
        elif (root / "bun.lockb").exists() and detect_tool("bun"):
            pm = "bun"
        elif detect_tool("npm"):
            pm = "npm"
        elif detect_tool("pnpm"):
            pm = "pnpm"
        elif detect_tool("yarn"):
            pm = "yarn"
        elif detect_tool("bun"):
            pm = "bun"

        tools = {
            "node": detect_tool("node") is not None,
            "npm": detect_tool("npm") is not None,
            "pnpm": detect_tool("pnpm") is not None,
            "yarn": detect_tool("yarn") is not None,
            "bun": detect_tool("bun") is not None,
        }
        missing = [t for t, ok in tools.items() if not ok]
        rt = DetectedRuntime(
            runtime="node",
            language=language,
            framework=framework,
            package_manager=pm,
            manifest="package.json",
            details={"scripts": scripts, "hasDependencies": bool(all_deps)},
            available_tools=tools,
            missing_tools=missing,
        )
        if pm is None and "npm" in missing:
            rt.install_hint = "Install Node.js (includes npm) from https://nodejs.org/"
        return rt

    def infer_commands(self, root: Path, runtime: DetectedRuntime) -> list[InferredCommand]:
        scripts = runtime.details.get("scripts", {}) if runtime.details else {}
        pm = runtime.package_manager
        pm_available = bool(pm) and runtime.available_tools.get(pm, False)
        cmds: list[InferredCommand] = []

        def run(*parts: str) -> Optional[str]:
            if not pm:
                return None
            return " ".join([pm, *parts])

        if "dev" in scripts:
            cmds.append(InferredCommand(
                action="Run dev server",
                command=run("run", "dev") if pm_available else None,
                kind="run",
                long_running=True,
                reason=f"Inferred from package.json scripts.dev: {scripts['dev']}",
                available=pm_available,
                missing_tool=None if pm_available else (pm or "npm"),
            ))
        if "start" in scripts:
            cmds.append(InferredCommand(
                action="Start",
                command=run("start") if pm_available else None,
                kind="run",
                long_running=True,
                reason=f"scripts.start: {scripts['start']}",
                available=pm_available,
                missing_tool=None if pm_available else (pm or "npm"),
            ))
        if "test" in scripts:
            cmds.append(InferredCommand(
                action="Run tests",
                command=run("test") if pm_available else None,
                kind="test",
                reason=f"scripts.test: {scripts['test']}",
                available=pm_available,
                missing_tool=None if pm_available else (pm or "npm"),
            ))
        if "build" in scripts:
            cmds.append(InferredCommand(
                action="Build",
                command=run("run", "build") if pm_available else None,
                kind="build",
                reason=f"scripts.build: {scripts['build']}",
                available=pm_available,
                missing_tool=None if pm_available else (pm or "npm"),
            ))
        if "lint" in scripts:
            cmds.append(InferredCommand(
                action="Lint",
                command=run("run", "lint") if pm_available else None,
                kind="lint",
                reason=f"scripts.lint: {scripts['lint']}",
                available=pm_available,
                missing_tool=None if pm_available else (pm or "npm"),
            ))
        if "typecheck" in scripts:
            cmds.append(InferredCommand(
                action="Type-check",
                command=run("run", "typecheck") if pm_available else None,
                kind="typecheck",
                reason=f"scripts.typecheck: {scripts['typecheck']}",
                available=pm_available,
                missing_tool=None if pm_available else (pm or "npm"),
            ))
        # Dependency install is sensitive.
        if runtime.details.get("hasDependencies") and pm:
            install_cmd = {
                "npm": "npm install",
                "pnpm": "pnpm install",
                "yarn": "yarn install",
                "bun": "bun install",
            }.get(pm, f"{pm} install")
            lock_present = any((root / lf).exists() for lf in ("package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"))
            node_modules_present = (root / "node_modules").is_dir()
            cmds.append(InferredCommand(
                action="Install dependencies",
                command=install_cmd,
                kind="deps",
                sensitive=True,
                reason="package.json declares dependencies." + (
                    "" if lock_present else " No lockfile found — install will resolve versions."
                ) + (" node_modules is missing." if not node_modules_present else ""),
                available=pm_available,
                missing_tool=None if pm_available else (pm or "npm"),
            ))
        return cmds


# --- Python ---


class PythonAdapter(RuntimeAdapter):
    name = "python"

    def detect(self, root: Path) -> Optional[DetectedRuntime]:
        markers = ("pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile", "uv.lock")
        if not any((root / m).exists() for m in markers):
            return None
        framework = None
        if (root / "pyproject.toml").is_file():
            try:
                text = (root / "pyproject.toml").read_text(encoding="utf-8", errors="ignore")
                if "[tool.poetry]" in text:
                    framework = "poetry"
                elif "[project]" in text and "uv" in text.lower():
                    framework = "uv"
            except OSError:
                pass

        tools = {
            "python": detect_tool("python") is not None or detect_tool("python3") is not None,
            "pip": detect_tool("pip") is not None or detect_tool("pip3") is not None,
            "poetry": detect_tool("poetry") is not None,
            "uv": detect_tool("uv") is not None,
            "pytest": detect_tool("pytest") is not None,
        }
        missing = [t for t, ok in tools.items() if not ok]

        pm = None
        if framework == "poetry" and tools["poetry"]:
            pm = "poetry"
        elif framework == "uv" and tools["uv"]:
            pm = "uv"
        elif tools["pip"]:
            pm = "pip"

        manifest = next((m for m in markers if (root / m).exists()), None)
        rt = DetectedRuntime(
            runtime="python",
            language="python",
            framework=framework,
            package_manager=pm,
            manifest=manifest,
            available_tools=tools,
            missing_tools=missing,
        )
        if not tools["python"]:
            rt.install_hint = "Install Python 3.11+ from https://www.python.org/downloads/"
        return rt

    def infer_commands(self, root: Path, runtime: DetectedRuntime) -> list[InferredCommand]:
        cmds: list[InferredCommand] = []
        pm = runtime.package_manager
        py = "python" if runtime.available_tools.get("python") else "python3"
        py_ok = runtime.available_tools.get("python", False)

        has_tests = (root / "tests").is_dir() or (root / "test").is_dir() or any(
            (root / d).is_dir() and any(f.name.startswith("test_") for f in (root / d).iterdir() if f.is_file())
            for d in ("tests", "test") if (root / d).is_dir()
        )
        if runtime.available_tools.get("pytest") and has_tests:
            cmds.append(InferredCommand(
                action="Run tests (pytest)",
                command="pytest" if pm != "poetry" else "poetry run pytest",
                kind="test",
                reason="pytest is installed and tests/ exists.",
            ))
        elif has_tests and py_ok:
            cmds.append(InferredCommand(
                action="Run tests (unittest)",
                command=f"{py} -m unittest discover -s tests" if (root / "tests").is_dir() else f"{py} -m unittest discover",
                kind="test",
                reason="tests/ directory present; pytest not detected.",
                available=py_ok,
            ))
        # App entrypoint detection.
        for candidate in ("app/main.py", "main.py", "src/main.py", "app.py", "manage.py"):
            if (root / candidate).is_file():
                run_cmd = f"{py} {candidate}"
                if pm == "poetry":
                    run_cmd = f"poetry run {run_cmd}"
                elif pm == "uv":
                    run_cmd = f"uv run {run_cmd}"
                cmds.append(InferredCommand(
                    action="Run application",
                    command=run_cmd,
                    kind="run",
                    long_running=True,
                    reason=f"Found entrypoint {candidate}.",
                    available=py_ok,
                    missing_tool=None if py_ok else "python",
                ))
                break
        # Dependency install.
        if (root / "requirements.txt").is_file() and runtime.available_tools.get("pip"):
            cmds.append(InferredCommand(
                action="Install dependencies",
                command="pip install -r requirements.txt",
                kind="deps",
                sensitive=True,
                reason="requirements.txt present.",
            ))
        elif runtime.framework == "poetry" and runtime.available_tools.get("poetry"):
            cmds.append(InferredCommand(
                action="Install dependencies",
                command="poetry install",
                kind="deps",
                sensitive=True,
                reason="poetry project detected.",
            ))
        elif runtime.framework == "uv" and runtime.available_tools.get("uv"):
            cmds.append(InferredCommand(
                action="Install dependencies",
                command="uv sync",
                kind="deps",
                sensitive=True,
                reason="uv project detected.",
            ))
        return cmds


# --- PHP / Laravel ---


class PhpAdapter(RuntimeAdapter):
    name = "php"

    def detect(self, root: Path) -> Optional[DetectedRuntime]:
        if not (root / "composer.json").is_file():
            return None
        framework = "laravel" if (root / "artisan").is_file() else None
        tools = {
            "php": detect_tool("php") is not None,
            "composer": detect_tool("composer") is not None,
            "phpunit": (root / "vendor" / "bin" / "phpunit").is_file() if (root / "vendor").is_dir() else False,
        }
        missing = [t for t, ok in tools.items() if not ok]
        rt = DetectedRuntime(
            runtime="php",
            language="php",
            framework=framework,
            package_manager="composer" if tools["composer"] else None,
            manifest="composer.json",
            available_tools=tools,
            missing_tools=missing,
        )
        if not tools["php"]:
            rt.install_hint = "Install PHP from https://www.php.net/downloads.php"
        if not tools["composer"]:
            rt.install_hint = (rt.install_hint or "") + " Install Composer from https://getcomposer.org/"
        return rt

    def infer_commands(self, root: Path, runtime: DetectedRuntime) -> list[InferredCommand]:
        cmds: list[InferredCommand] = []
        php_ok = runtime.available_tools.get("php", False)
        if runtime.framework == "laravel" and php_ok:
            cmds.append(InferredCommand(
                action="Run dev server",
                command="php artisan serve",
                kind="run",
                long_running=True,
                reason="Laravel artisan is present.",
            ))
            cmds.append(InferredCommand(
                action="Run tests",
                command="php artisan test",
                kind="test",
                reason="Laravel artisan test.",
            ))
        elif php_ok:
            # Generic PHP.
            for candidate in ("public/index.php", "index.php", "server.php"):
                if (root / candidate).is_file():
                    cmds.append(InferredCommand(
                        action="Run dev server",
                        command=f"php -S 127.0.0.1:8000 -t {Path(candidate).parent.as_posix() or '.'}",
                        kind="run",
                        long_running=True,
                        reason=f"Found {candidate}; using built-in server.",
                    ))
                    break
        if runtime.available_tools.get("composer") and (root / "composer.json").is_file():
            cmds.append(InferredCommand(
                action="Install dependencies",
                command="composer install",
                kind="deps",
                sensitive=True,
                reason="composer.json present.",
            ))
        return cmds


# --- Registry ---


RUNTIME_ADAPTERS: list[RuntimeAdapter] = [
    NodeAdapter(),
    PythonAdapter(),
    PhpAdapter(),
]


def detect_runtime(root: Path) -> DetectedRuntime:
    """Run all adapters; return the first match or an `unknown` runtime."""
    for adapter in RUNTIME_ADAPTERS:
        try:
            detected = adapter.detect(root)
        except Exception:
            detected = None
        if detected is not None:
            return detected
    return DetectedRuntime(runtime="unknown", install_hint="No recognized project manifest found.")


def infer_commands(root: Path, runtime: DetectedRuntime) -> list[InferredCommand]:
    """Infer run/test/build/lint/typecheck/deps commands from manifests."""
    for adapter in RUNTIME_ADAPTERS:
        if adapter.name == runtime.runtime:
            try:
                return adapter.infer_commands(root, runtime)
            except Exception:
                return []
    return []


def preview_url_from_output(text: str) -> Optional[str]:
    """Extract a local dev-server URL from process output, if present."""
    import re
    m = re.search(r"https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(:\d+)?", text)
    if not m:
        return None
    url = m.group(0)
    # Normalize 0.0.0.0 / ::1 to 127.0.0.1 for browser access.
    url = url.replace("0.0.0.0", "127.0.0.1").replace("[::1]", "127.0.0.1").replace("::1", "127.0.0.1")
    return url
