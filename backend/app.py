"""Asyncio WebSocket server for MindScope backend."""

import asyncio
import logging
import signal
import sys
import os
from pathlib import Path

import websockets
from websockets.asyncio.server import Server, ServerConnection

from .ipc.protocol import Message, MessageType
from .ipc.router import MessageRouter
from .pc_model.database import DatabaseManager
from .meter_engine.broadcaster import MeterBroadcaster
from .ai.auditor import AIAuditor
from .ai.whisper import WhisperTranscriber

VERSION = "2.0.0-alpha.2"
DEFAULT_PORT = 8765

log = logging.getLogger("mindscope")


def _load_env_file() -> None:
    """Load key=value pairs from .env files into process environment."""
    repo_root = Path(__file__).resolve().parent.parent
    env_paths = [repo_root / ".env", repo_root / "backend" / ".env"]

    for env_path in env_paths:
        if not env_path.exists():
            continue
        try:
            with env_path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    text = line.strip()
                    if not text or text.startswith("#"):
                        continue
                    if "=" not in text:
                        continue
                    key, value = text.split("=", 1)
                    os.environ.setdefault(key.strip(), value.strip())
        except OSError:
            log.exception("Unable to read env file: %s", env_path)


_load_env_file()


class MindScopeServer:
    """WebSocket server that bridges React frontend to Python backend."""

    def __init__(self, host: str = "127.0.0.1", port: int = DEFAULT_PORT):
        self.host = host
        self.port = port
        self.db = DatabaseManager()
        self.router: MessageRouter | None = None
        self.clients: set[ServerConnection] = set()
        self._server: Server | None = None

        # Phase 2: meter broadcasting and active session
        self.broadcaster: MeterBroadcaster | None = None
        self.active_session = None  # SessionManager, set by router

    async def start(self) -> None:
        """Initialize DB, meter broadcaster, and start WebSocket server."""
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        )

        log.info("Initializing database...")
        await self.db.initialize()

        # Create AI auditor (None if no API key)
        self.ai_auditor = AIAuditor.create()

        # Create Whisper transcriber
        self.whisper = WhisperTranscriber()
        if self.whisper.available:
            log.info("Whisper STT enabled")
        else:
            log.info("Whisper STT disabled — no OPENAI_API_KEY")

        # Create router with server reference
        self.router = MessageRouter(self.db, self, self.ai_auditor)

        # Start meter broadcaster
        self.broadcaster = MeterBroadcaster(
            broadcast_fn=self._broadcast_meter_event,
            db_manager=self.db,
        )
        await self.broadcaster.start()
        log.info("Meter broadcaster started")

        log.info("Starting WebSocket server on %s:%d", self.host, self.port)
        self._server = await websockets.serve(
            self._handle_connection,
            self.host,
            self.port,
            max_size=10 * 1024 * 1024,  # 10MB max message size
        )

        # Signal to Electron that we're ready
        print(f"MINDSCOPE_READY:{self.port}", flush=True)
        log.info("Server ready on port %d", self.port)

        # Keep running until cancelled
        await self._wait_for_shutdown()

    async def _broadcast_meter_event(self, event_data: dict) -> None:
        """Broadcast a meter event to all connected clients."""
        msg = Message(type=MessageType.METER_EVENT.value, data=event_data)
        await self.broadcast(msg)

    async def _wait_for_shutdown(self) -> None:
        """Wait for shutdown signal."""
        stop = asyncio.get_event_loop().create_future()

        def _signal_handler():
            if not stop.done():
                stop.set_result(None)

        loop = asyncio.get_event_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, _signal_handler)
            except NotImplementedError:
                pass  # Windows

        try:
            await stop
        finally:
            await self.shutdown()

    async def shutdown(self) -> None:
        """Graceful shutdown."""
        log.info("Shutting down...")

        # Stop active session if any
        if self.active_session:
            try:
                await self.active_session.end()
            except Exception:
                log.exception("Error ending active session during shutdown")
            self.active_session = None

        # Stop meter broadcaster
        if self.broadcaster:
            await self.broadcaster.stop()
            self.broadcaster = None

        if self._server:
            self._server.close()
            await self._server.wait_closed()
        await self.db.close()
        log.info("Shutdown complete.")

    async def _handle_connection(self, websocket: ServerConnection) -> None:
        """Handle a single WebSocket connection."""
        self.clients.add(websocket)
        remote = websocket.remote_address
        log.info("Client connected: %s", remote)

        # Send init message (include profiles so frontend has them immediately)
        db_status = await self.db.get_status()
        pcs = await self.db.list_pcs()
        init_msg = Message.init(VERSION, db_status)
        init_msg.data["profiles"] = [pc.to_dict() for pc in pcs]
        await websocket.send(init_msg.to_json())

        try:
            async for raw in websocket:
                try:
                    msg = Message.from_json(str(raw))
                    log.debug("Received: %s", msg.type)
                    response = await self.router.route(msg)
                    await websocket.send(response.to_json())
                except Exception as e:
                    log.exception("Error processing message")
                    error = Message.error(str(e))
                    await websocket.send(error.to_json())
        except websockets.ConnectionClosed:
            log.info("Client disconnected: %s", remote)
        finally:
            self.clients.discard(websocket)

    async def broadcast(self, msg: Message) -> None:
        """Send a message to all connected clients."""
        if not self.clients:
            return
        payload = msg.to_json()
        await asyncio.gather(
            *(client.send(payload) for client in self.clients),
            return_exceptions=True,
        )
