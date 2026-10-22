"""Tests for Phase 10 runtime & framework detection.

Uses temporary project directories with real manifest files (package.json,
pyproject.toml, composer.json) but does NOT install dependencies or run any
commands. Tool availability is detected via PATH; tests that depend on a tool
being installed skip gracefully when it's missing.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.runtime_detect import (
    InferredCommand,
    NodeAdapter,
    PhpAdapter,
    PythonAdapter,
    RuntimeAdapter,
    detect_runtime,
    infer_commands,
    preview_url_from_output,
)


def _write(root: Path, name: str, content: str) -> None:
    (root / name).write_text(content, encoding="utf-8")


class TestNodeDetection:
    def test_detects_vite_project(self, project_dir: Path):
        _write(project_dir, "package.json", json.dumps({
            "name": "vite-app",
            "scripts": {"dev": "vite", "build": "vite build", "test": "vitest"},
            "devDependencies": {"vite": "^5.0.0"},
        }))
        _write(project_dir, "tsconfig.json", "{}")
        rt = detect_runtime(project_dir)
        assert rt.runtime == "node"
        assert rt.language == "typescript"
        assert rt.framework == "vite"

    def test_detects_next_project(self, project_dir: Path):
        _write(project_dir, "package.json", json.dumps({
            "name": "next-app",
            "scripts": {"dev": "next dev", "build": "next build"},
            "dependencies": {"next": "^14.0.0", "react": "^18"},
        }))
        rt = detect_runtime(project_dir)
        assert rt.runtime == "node"
        assert rt.framework == "next"

    def test_detects_nest_project(self, project_dir: Path):
        _write(project_dir, "package.json", json.dumps({
            "name": "nest-app",
            "dependencies": {"@nestjs/core": "^10"},
        }))
        rt = detect_runtime(project_dir)
        assert rt.framework == "nest"

    def test_detects_express_project(self, project_dir: Path):
        _write(project_dir, "package.json", json.dumps({
            "name": "ex",
            "dependencies": {"express": "^4"},
        }))
        rt = detect_runtime(project_dir)
        assert rt.framework == "express"

    def test_no_package_returns_none(self, project_dir: Path):
        rt = NodeAdapter().detect(project_dir)
        assert rt is None

    def test_infers_dev_test_build(self, project_dir: Path):
        _write(project_dir, "package.json", json.dumps({
            "name": "x",
            "scripts": {"dev": "vite", "test": "vitest", "build": "vite build", "lint": "eslint ."},
            "devDependencies": {"vite": "^5"},
        }))
        rt = detect_runtime(project_dir)
        cmds = infer_commands(project_dir, rt)
        actions = [c.action for c in cmds]
        assert "Run dev server" in actions
        assert "Run tests" in actions
        assert "Build" in actions
        assert "Lint" in actions


class TestPythonDetection:
    def test_detects_requirements(self, project_dir: Path):
        _write(project_dir, "requirements.txt", "fastapi\nuvicorn\n")
        rt = detect_runtime(project_dir)
        assert rt.runtime == "python"
        assert rt.language == "python"

    def test_detects_pyproject_poetry(self, project_dir: Path):
        _write(project_dir, "pyproject.toml", "[tool.poetry]\nname='x'\nversion='0.1'\n")
        rt = detect_runtime(project_dir)
        assert rt.runtime == "python"
        assert rt.framework == "poetry"

    def test_infers_pytest(self, project_dir: Path):
        _write(project_dir, "requirements.txt", "pytest\n")
        (project_dir / "tests").mkdir()
        _write(project_dir / "tests", "test_x.py", "def test_x():\n    assert True\n")
        rt = detect_runtime(project_dir)
        cmds = infer_commands(project_dir, rt)
        assert any(c.kind == "test" for c in cmds)

    def test_infers_unittest_fallback(self, project_dir: Path):
        _write(project_dir, "requirements.txt", "fastapi\n")
        (project_dir / "tests").mkdir()
        _write(project_dir / "tests", "test_y.py", "def test_y(): pass\n")
        rt = detect_runtime(project_dir)
        cmds = infer_commands(project_dir, rt)
        # pytest not installed -> unittest fallback
        assert any(c.kind == "test" for c in cmds)


class TestPhpDetection:
    def test_detects_laravel(self, project_dir: Path):
        _write(project_dir, "composer.json", json.dumps({"name": "laravel/app"}))
        _write(project_dir, "artisan", "#!/usr/bin/env php\n<?php // artisan")
        rt = detect_runtime(project_dir)
        assert rt.runtime == "php"
        assert rt.framework == "laravel"

    def test_detects_plain_php(self, project_dir: Path):
        _write(project_dir, "composer.json", json.dumps({"name": "plain/php"}))
        rt = detect_runtime(project_dir)
        assert rt.runtime == "php"
        assert rt.framework is None


class TestUnknown:
    def test_empty_dir_is_unknown(self, project_dir: Path):
        rt = detect_runtime(project_dir)
        assert rt.runtime == "unknown"


class TestPreviewUrl:
    def test_detects_localhost(self):
        assert preview_url_from_output("Local: http://localhost:5173/") == "http://localhost:5173/"

    def test_normalizes_zero(self):
        url = preview_url_from_output("Listening on http://0.0.0.0:3000")
        assert url is not None
        assert "127.0.0.1" in url
        assert "0.0.0.0" not in url

    def test_returns_none_when_absent(self):
        assert preview_url_from_output("build done") is None


class TestExtensibility:
    def test_adapter_registry_includes_all(self):
        from app.runtime_detect import RUNTIME_ADAPTERS
        names = {a.name for a in RUNTIME_ADAPTERS}
        assert {"node", "python", "php"}.issubset(names)

    def test_custom_adapter_can_be_added(self, project_dir: Path):
        class RustAdapter(RuntimeAdapter):
            name = "rust"
            def detect(self, root: Path):
                if (root / "Cargo.toml").is_file():
                    from app.runtime_detect import DetectedRuntime
                    return DetectedRuntime(runtime="rust", language="rust", manifest="Cargo.toml")
                return None
            def infer_commands(self, root, runtime):
                return [InferredCommand(action="Build", command="cargo build", kind="build", reason="Cargo.toml present.")]
        _write(project_dir, "Cargo.toml", "[package]\nname='x'\nversion='0.1'\n")
        from app.runtime_detect import RUNTIME_ADAPTERS
        original = list(RUNTIME_ADAPTERS)
        RUNTIME_ADAPTERS.insert(0, RustAdapter())
        try:
            rt = detect_runtime(project_dir)
            assert rt.runtime == "rust"
            cmds = infer_commands(project_dir, rt)
            assert any(c.action == "Build" for c in cmds)
        finally:
            RUNTIME_ADAPTERS[:] = original
