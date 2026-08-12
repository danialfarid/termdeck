import os
import tempfile


TEST_DATA_DIRECTORY = tempfile.TemporaryDirectory(prefix="termdeck-tests-")
os.environ["TERMDECK_DATA_DIR"] = TEST_DATA_DIRECTORY.name
