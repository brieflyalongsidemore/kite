"""The browser extension as a zip, built from extension/ when asked for, so the download always matches this Kite.
`python -m kite.extension docs/kite-extension.zip` writes the copy the landing page links to."""

import io
import sys
import zipfile

from . import config

EXTENSION = config.ROOT / "extension"


def zip_bytes():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(EXTENSION.rglob("*")):
            if p.is_file() and not p.name.startswith("."):
                z.write(p, f"kite-extension/{p.relative_to(EXTENSION).as_posix()}")
    return buf.getvalue()


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "kite-extension.zip"
    with open(out, "wb") as f:
        f.write(zip_bytes())
    print(f"Wrote {out}")
