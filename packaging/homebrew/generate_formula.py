import json
import re
import subprocess
import sys
import tempfile
import urllib.request
import venv
from pathlib import Path


class HomebrewFormulaGenerator:
    """Emits a complete Homebrew formula for termdeck, resource blocks included.

    Homebrew builds Python apps from source, so the formula must list every transitive dependency as a
    `resource` with a pinned sdist url and sha256. This resolves that set the only reliable way: build a
    throwaway venv, install the released termdeck from PyPI, read back exactly what pip chose, then look up
    each package's sdist on PyPI.

    Run it AFTER `termdeck <version>` is live on PyPI (it downloads from there), then copy the output into
    the tap repo as Formula/termdeck.rb:

        python packaging/homebrew/generate_formula.py            # version from termdeck/__init__.py
        python packaging/homebrew/generate_formula.py 0.2.0
    """

    PYPI_JSON_URL = "https://pypi.org/pypi/{package}/{version}/json"
    SDIST_PACKAGE_TYPE = "sdist"
    PACKAGE_NAME = "termdeck"
    VERSION_FILE = Path(__file__).resolve().parents[2] / "termdeck" / "__init__.py"
    VERSION_PATTERN = r'__version__\s*=\s*"([^"]+)"'
    OUTPUT_FILE = Path(__file__).resolve().parent / "termdeck.rb"
    PYTHON_FORMULA = "python@3.13"
    SYSTEM_DEPENDENCIES = ("dtach", "ripgrep")
    PIP_FREEZE_SEPARATOR = "=="
    EXCLUDED_FROM_RESOURCES = frozenset({"pip", "setuptools", "wheel", PACKAGE_NAME})

    FORMULA_TEMPLATE = '''class Termdeck < Formula
  include Language::Python::Virtualenv

  desc "Browser terminal deck with persistent sessions and claude/codex resume"
  homepage "https://github.com/danialfarid/termdeck"
  url "{sdist_url}"
  sha256 "{sdist_sha256}"
  license "Apache-2.0"

  depends_on "{python_formula}"
{system_dependency_lines}
{resource_blocks}
  def install
    virtualenv_install_with_resources
  end

  service do
    run [opt_bin/"termdeck"]
    keep_alive true
    log_path var/"log/termdeck.log"
    error_log_path var/"log/termdeck.log"
  end

  test do
    assert_match "termdeck #{{version}}", shell_output("#{{bin}}/termdeck --version")
    assert_match "data dir", shell_output("#{{bin}}/termdeck doctor", 1)
  end
end
'''

    RESOURCE_TEMPLATE = '''  resource "{name}" do
    url "{url}"
    sha256 "{sha256}"
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
    def fetch_sdist(package: str, version: str) -> tuple[str, str]:
        url = HomebrewFormulaGenerator.PYPI_JSON_URL.format(package=package, version=version)
        with urllib.request.urlopen(url, timeout=30) as response:
            metadata = json.loads(response.read())
        for entry in metadata["urls"]:
            if entry["packagetype"] == HomebrewFormulaGenerator.SDIST_PACKAGE_TYPE:
                return entry["url"], entry["digests"]["sha256"]
        raise RuntimeError(f"{package} {version} has no sdist on PyPI; Homebrew cannot build it from source")

    @staticmethod
    def resolve_dependency_versions(version: str) -> list[tuple[str, str]]:
        with tempfile.TemporaryDirectory() as temp_dir:
            environment_dir = Path(temp_dir) / "resolver"
            venv.create(environment_dir, with_pip=True)
            pip = environment_dir / "bin" / "pip"
            subprocess.run([str(pip), "install", "--quiet",
                            f"{HomebrewFormulaGenerator.PACKAGE_NAME}=={version}"], check=True)
            frozen = subprocess.run([str(pip), "freeze"], check=True, capture_output=True, text=True).stdout
        packages: list[tuple[str, str]] = []
        for line in frozen.splitlines():
            if HomebrewFormulaGenerator.PIP_FREEZE_SEPARATOR not in line:
                continue
            name, pinned = line.split(HomebrewFormulaGenerator.PIP_FREEZE_SEPARATOR, 1)
            if name.lower() not in HomebrewFormulaGenerator.EXCLUDED_FROM_RESOURCES:
                packages.append((name, pinned))
        return sorted(packages, key=lambda item: item[0].lower())

    @staticmethod
    def render(version: str) -> str:
        sdist_url, sdist_sha256 = HomebrewFormulaGenerator.fetch_sdist(
            HomebrewFormulaGenerator.PACKAGE_NAME, version)
        print(f"termdeck {version} sdist resolved", file=sys.stderr)
        resource_blocks = ""
        for name, pinned in HomebrewFormulaGenerator.resolve_dependency_versions(version):
            resource_url, resource_sha256 = HomebrewFormulaGenerator.fetch_sdist(name, pinned)
            print(f"  resource {name} {pinned}", file=sys.stderr)
            resource_blocks += HomebrewFormulaGenerator.RESOURCE_TEMPLATE.format(
                name=name, url=resource_url, sha256=resource_sha256)
        system_dependency_lines = "".join(f'  depends_on "{name}"\n'
                                          for name in HomebrewFormulaGenerator.SYSTEM_DEPENDENCIES)
        return HomebrewFormulaGenerator.FORMULA_TEMPLATE.format(
            sdist_url=sdist_url, sdist_sha256=sdist_sha256, python_formula=HomebrewFormulaGenerator.PYTHON_FORMULA,
            system_dependency_lines=system_dependency_lines, resource_blocks="\n" + resource_blocks)

    @staticmethod
    def main(argv: list[str]) -> int:
        version = argv[1] if len(argv) > 1 else HomebrewFormulaGenerator.read_local_version()
        HomebrewFormulaGenerator.OUTPUT_FILE.write_text(HomebrewFormulaGenerator.render(version))
        print(f"wrote {HomebrewFormulaGenerator.OUTPUT_FILE}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(HomebrewFormulaGenerator.main(sys.argv))
