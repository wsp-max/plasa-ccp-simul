import sys
from pathlib import Path


def pytest_configure():
    # Make `app/` importable as top-level modules (e.g. `import schemas`) as used by existing tests.
    root = Path(__file__).resolve().parents[1]
    app = root / "app"
    for p in (str(app), str(root)):
        if p not in sys.path:
            sys.path.insert(0, p)

