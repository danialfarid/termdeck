import hashlib
import json
import re
import subprocess
import sys
import tempfile
import urllib.request
import venv
from pathlib import Path


class HomebrewFormulaGenerator:
    """Emits the Homebrew formula for termdeck, built entirely from prebuilt CPython 3.13 wheels.

    termdeck itself is NOT on PyPI — the formula builds it from the GitHub release tarball (pure Python, so
    hatchling is enough). Its dependencies ARE on PyPI, and the important design choice is to install them
    from WHEELS rather than sdists: a source build would drag in a Rust toolchain (pydantic-core builds via
    maturin/setuptools-rust) plus a C compiler, and Homebrew's install sandbox has no network, so every build
    backend would have to be vendored too. Wheels sidestep all of it — nothing compiles at install time.

    The cost is that the four packages with native extensions (pydantic-core, setproctitle, watchdog,
    websockets) are architecture-specific, so their wheels go in per-arch on_arm/on_intel blocks; the rest are
    universal `py3-none-any` wheels. macOS only (Apple Silicon + Intel); Linux users install with uv/pipx.

    Run it AFTER the `vX.Y.Z` tag exists on GitHub (it hashes the release tarball), then copy the output into
    the tap repo as Formula/termdeck.rb:

        python packaging/homebrew/generate_formula.py            # version from termdeck/__init__.py
        python packaging/homebrew/generate_formula.py 0.2.0
    """

    OWNER_REPO = "danialfarid/termdeck"
    GITHUB_TARBALL_URL = "https://github.com/{owner_repo}/archive/refs/tags/v{version}.tar.gz"
    PYPI_JSON_URL = "https://pypi.org/pypi/{package}/json"
    PACKAGE_NAME = "termdeck"
    BUILD_BACKEND = "hatchling"
    PYTHON_TAG = "3.13"
    PYTHON_FORMULA = "python@3.13"
    ABI = "cp313"
    ARM_PLATFORMS = ("macosx_11_0_arm64", "macosx_10_12_universal2")
    INTEL_PLATFORMS = ("macosx_10_13_x86_64", "macosx_10_12_x86_64", "macosx_11_0_x86_64", "macosx_10_9_x86_64")
    NATIVE_PACKAGES = ("pydantic-core", "setproctitle", "watchdog", "websockets")
    UNIVERSAL_WHEEL_SUFFIX = "py3-none-any.whl"
    SYSTEM_DEPENDENCIES = ("dtach", "ripgrep")
    PIP_FREEZE_SEPARATOR = "=="
    EXCLUDED = frozenset({"pip", "setuptools", "wheel", PACKAGE_NAME})
    PROJECT_ROOT = Path(__file__).resolve().parents[2]
    VERSION_FILE = PROJECT_ROOT / "termdeck" / "__init__.py"
    VERSION_PATTERN = r'__version__\s*=\s*"([^"]+)"'
    OUTPUT_FILE = Path(__file__).resolve().parent / "termdeck.rb"
    DOWNLOAD_CHUNK = 1 << 16

    FORMULA_TEMPLATE = '''class Termdeck < Formula
  desc "Browser terminal deck with persistent sessions and claude/codex resume"
  homepage "https://github.com/danialfarid/termdeck"
  url "{tarball_url}"
  sha256 "{tarball_sha256}"
  license "Apache-2.0"

  depends_on "{python_formula}"
{system_dependency_lines}
  on_macos do
    on_arm do
{arm_blocks}    end

    on_intel do
{intel_blocks}    end
  end

{universal_blocks}  def install
    venv_root = libexec
    system Formula["{python_formula}"].opt_bin/"python{python_tag}", "-m", "venv", venv_root
    pip = venv_root/"bin/pip"
    system pip, "install", "--no-deps", "--no-index", *resources.map(&:cached_download)
    system pip, "install", "--no-deps", "--no-build-isolation", buildpath
    bin.install_symlink venv_root/"bin/termdeck"
  end

  service do
    run [opt_bin/"termdeck"]
    keep_alive true
    log_path var/"log/termdeck.log"
    error_log_path var/"log/termdeck.log"
  end

  test do
    assert_match "termdeck #{{version}}", shell_output("#{{bin}}/termdeck --version")
    assert_match "all required programs present", shell_output("#{{bin}}/termdeck doctor")
  end
end
'''

    @staticmethod
    def read_local_version() -> str:
        match = re.search(HomebrewFormulaGenerator.VERSION_PATTERN,
                          HomebrewFormulaGenerator.VERSION_FILE.read_text())
        if match is None:
            raise RuntimeError(f"no __version__ found in {HomebrewFormulaGenerator.VERSION_FILE}")
        return match.group(1)

    @staticmethod
    def tarball_url_and_sha256(version: str) -> tuple[str, str]:
        url = HomebrewFormulaGenerator.GITHUB_TARBALL_URL.format(
            owner_repo=HomebrewFormulaGenerator.OWNER_REPO, version=version)
        digest = hashlib.sha256()
        with urllib.request.urlopen(url, timeout=60) as response:
            for chunk in iter(lambda: response.read(HomebrewFormulaGenerator.DOWNLOAD_CHUNK), b""):
                digest.update(chunk)
        return url, digest.hexdigest()

    @staticmethod
    def resolve_dependency_specs() -> list[str]:
        with tempfile.TemporaryDirectory() as temp_dir:
            environment_dir = Path(temp_dir) / "resolver"
            venv.create(environment_dir, with_pip=True)
            pip = environment_dir / "bin" / "pip"
            subprocess.run([str(pip), "install", "--quiet", str(HomebrewFormulaGenerator.PROJECT_ROOT),
                            HomebrewFormulaGenerator.BUILD_BACKEND], check=True)
            frozen = subprocess.run([str(pip), "freeze"], check=True, capture_output=True, text=True).stdout
        specs: list[str] = []
        for line in frozen.splitlines():
            if HomebrewFormulaGenerator.PIP_FREEZE_SEPARATOR not in line:
                continue
            name, _ = line.split(HomebrewFormulaGenerator.PIP_FREEZE_SEPARATOR, 1)
            if name.lower() not in HomebrewFormulaGenerator.EXCLUDED:
                specs.append(line.strip())
        return specs

    @staticmethod
    def download_wheels(specs: list[str], platforms: tuple[str, ...], destination: Path) -> None:
        destination.mkdir(parents=True, exist_ok=True)
        for spec in specs:
            for platform in platforms:
                argv = [sys.executable, "-m", "pip", "download", spec, "--only-binary", ":all:", "--no-deps",
                        "--python-version", HomebrewFormulaGenerator.PYTHON_TAG, "--implementation", "cp",
                        "--abi", HomebrewFormulaGenerator.ABI, "--platform", platform, "--dest", str(destination)]
                if subprocess.run(argv, capture_output=True).returncode == 0:
                    break
            else:
                raise RuntimeError(f"no {HomebrewFormulaGenerator.ABI} wheel for {spec} on {platforms}")

    @staticmethod
    def package_from_wheel(filename: str) -> str:
        return filename.split("-")[0].replace("_", "-")

    @staticmethod
    def wheel_url_and_sha(filename: str) -> tuple[str, str]:
        package = HomebrewFormulaGenerator.package_from_wheel(filename)
        with urllib.request.urlopen(HomebrewFormulaGenerator.PYPI_JSON_URL.format(package=package), timeout=30) as r:
            metadata = json.loads(r.read())
        for release in metadata["releases"].values():
            for entry in release:
                if entry["filename"] == filename:
                    return entry["url"], entry["digests"]["sha256"]
        raise RuntimeError(f"no PyPI url for {filename}")

    @staticmethod
    def resource_block(name: str, filename: str, indent: str) -> str:
        url, sha = HomebrewFormulaGenerator.wheel_url_and_sha(filename)
        return f'{indent}resource "{name}" do\n{indent}  url "{url}"\n{indent}  sha256 "{sha}"\n{indent}end\n\n'

    @staticmethod
    def render(version: str) -> str:
        tarball_url, tarball_sha256 = HomebrewFormulaGenerator.tarball_url_and_sha256(version)
        specs = HomebrewFormulaGenerator.resolve_dependency_specs()
        print(f"termdeck {version}: {len(specs)} dependencies", file=sys.stderr)
        with tempfile.TemporaryDirectory() as temp_dir:
            arm_dir, intel_dir = Path(temp_dir) / "arm", Path(temp_dir) / "intel"
            native_specs = [s for s in specs
                            if s.split(HomebrewFormulaGenerator.PIP_FREEZE_SEPARATOR)[0].lower().replace("_", "-")
                            in HomebrewFormulaGenerator.NATIVE_PACKAGES]
            HomebrewFormulaGenerator.download_wheels(specs, HomebrewFormulaGenerator.ARM_PLATFORMS, arm_dir)
            HomebrewFormulaGenerator.download_wheels(native_specs, HomebrewFormulaGenerator.INTEL_PLATFORMS, intel_dir)
            universal_blocks, arm_blocks, intel_blocks = "", "", ""
            for wheel in sorted(arm_dir.glob("*.whl")):
                name = HomebrewFormulaGenerator.package_from_wheel(wheel.name)
                if wheel.name.endswith(HomebrewFormulaGenerator.UNIVERSAL_WHEEL_SUFFIX):
                    universal_blocks += HomebrewFormulaGenerator.resource_block(name, wheel.name, "  ")
                else:
                    arm_blocks += HomebrewFormulaGenerator.resource_block(name, wheel.name, "      ")
            for wheel in sorted(intel_dir.glob("*.whl")):
                name = HomebrewFormulaGenerator.package_from_wheel(wheel.name)
                intel_blocks += HomebrewFormulaGenerator.resource_block(name, wheel.name, "      ")
        system_dependency_lines = "".join(f'  depends_on "{name}"\n'
                                          for name in HomebrewFormulaGenerator.SYSTEM_DEPENDENCIES)
        return HomebrewFormulaGenerator.FORMULA_TEMPLATE.format(
            tarball_url=tarball_url, tarball_sha256=tarball_sha256,
            python_formula=HomebrewFormulaGenerator.PYTHON_FORMULA, python_tag=HomebrewFormulaGenerator.PYTHON_TAG,
            system_dependency_lines=system_dependency_lines, arm_blocks=arm_blocks, intel_blocks=intel_blocks,
            universal_blocks=universal_blocks)

    @staticmethod
    def main(argv: list[str]) -> int:
        version = argv[1] if len(argv) > 1 else HomebrewFormulaGenerator.read_local_version()
        HomebrewFormulaGenerator.OUTPUT_FILE.write_text(HomebrewFormulaGenerator.render(version))
        print(f"wrote {HomebrewFormulaGenerator.OUTPUT_FILE}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(HomebrewFormulaGenerator.main(sys.argv))
