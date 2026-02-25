"""Entry point: python -m backend"""

from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

import asyncio
from .app import MindScopeServer


def main():
    server = MindScopeServer()
    asyncio.run(server.start())


if __name__ == "__main__":
    main()
