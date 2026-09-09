import hashlib
import json
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path


class CoreFormulaGenerator:
    PYTHON_VERSION = (3, 14)
    RELEASE_URL = "https://github.com/danialfarid/termdeck/archive/refs/tags/v{version}.tar.gz"
    PYPI_URL = "https://pypi.org/pypi/{name}/{version}/json"
    PROVIDED_PACKAGES = frozenset({"termdeck", "certifi", "pydantic", "pydantic-core", "annotated-types",
                                  "typing-extensions", "typing-inspection"})
    TEMPLATE_PATH = Path(__file__).with_name("core-formula.rb.in")

    @staticmethod
    def source_archive_metadata(name: str, version: str) -> tuple[str, str]:
        url = CoreFormulaGenerator.PYPI_URL.format(name=name, version=version)
        with urllib.request.urlopen(url, timeout=60) as response:
            metadata = json.load(response)
        sources = [entry for entry in metadata["urls"] if entry["packagetype"] == "sdist" and not entry["yanked"]]
        if len(sources) != 1:
            raise ValueError(f"Expected one non-yanked source archive for {name}=={version}")
        source = sources[0]
        with urllib.request.urlopen(source["url"], timeout=60) as response:
            actual_hash = hashlib.file_digest(response, "sha256").hexdigest()
        if actual_hash != source["digests"]["sha256"]:
            raise ValueError(f"Source checksum mismatch for {name}=={version}")
        return source["url"], actual_hash

    @staticmethod
    def render(version: str) -> str:
        if sys.version_info[:2] != CoreFormulaGenerator.PYTHON_VERSION:
            raise RuntimeError("Run with Python 3.14 to match the core formula interpreter")
        if not re.fullmatch(r"\d+\.\d+\.\d+", version):
            raise ValueError("A stable release version such as 0.11.1 is required")
        release_url = CoreFormulaGenerator.RELEASE_URL.format(version=version)
        with tempfile.TemporaryDirectory(prefix="termdeck-core-resolver-") as temporary:
            directory = Path(temporary)
            archive = directory / f"termdeck-{version}.tar.gz"
            with urllib.request.urlopen(release_url, timeout=60) as response:
                archive.write_bytes(response.read())
            release_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
            report_path = directory / "report.json"
            subprocess.run([sys.executable, "-m", "pip", "install", "--dry-run", "--ignore-installed",
                            "--report", str(report_path), str(archive)], check=True, stdout=sys.stderr)
            report = json.loads(report_path.read_text())
        resources: list[str] = []
        for entry in sorted(report["install"], key=lambda entry: entry["metadata"]["name"].lower()):
            metadata = entry["metadata"]
            name = re.sub(r"[-_.]+", "-", metadata["name"].lower())
            if name in CoreFormulaGenerator.PROVIDED_PACKAGES:
                continue
            url, checksum = CoreFormulaGenerator.source_archive_metadata(name, metadata["version"])
            resources.append(f'  resource "{name}" do\n    url "{url}"\n    sha256 "{checksum}"\n  end\n')
        return CoreFormulaGenerator.TEMPLATE_PATH.read_text().replace("@RELEASE_URL@", release_url).replace(
            "@RELEASE_SHA256@", release_hash).replace("@RESOURCES@", "\n".join(resources))

    @staticmethod
    def main(arguments: list[str]) -> None:
        if len(arguments) != 2:
            raise ValueError("Usage: python3.14 packaging/homebrew/generate_core_formula.py VERSION")
        print(CoreFormulaGenerator.render(arguments[1]), end="")


if __name__ == "__main__":
    CoreFormulaGenerator.main(sys.argv)
