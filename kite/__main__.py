"""python -m kite [--host 127.0.0.1] [--port 8788]"""

import argparse
import os


def main():
    parser = argparse.ArgumentParser(prog="kite", description="Kite: grow on social media. An LLM plans and writes; Jev decides.")
    parser.add_argument("--host", default=os.environ.get("KITE_HOST", "127.0.0.1"), help="default 127.0.0.1 (this machine only)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8788")))
    args = parser.parse_args()
    from .server import serve
    serve(args.host, args.port)


if __name__ == "__main__":
    main()
