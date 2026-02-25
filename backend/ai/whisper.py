"""Whisper speech-to-text via OpenAI API."""

from __future__ import annotations

import logging
import os

import httpx

log = logging.getLogger("mindscope.whisper")

WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions"


class WhisperTranscriber:
    """Transcribes audio using OpenAI Whisper API."""

    def __init__(self) -> None:
        self._api_key = os.environ.get("OPENAI_API_KEY", "")

    @property
    def available(self) -> bool:
        return bool(self._api_key)

    async def transcribe(self, audio_bytes: bytes, fmt: str = "webm") -> str:
        """Transcribe audio bytes using whisper-1. Returns transcribed text."""
        if not self.available:
            raise RuntimeError("OPENAI_API_KEY not set")

        log.info("Sending %d bytes (%s) to Whisper API", len(audio_bytes), fmt)
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                WHISPER_URL,
                headers={"Authorization": f"Bearer {self._api_key}"},
                files={"file": (f"audio.{fmt}", audio_bytes, f"audio/{fmt}")},
                data={"model": "whisper-1", "language": "en"},
            )
            resp.raise_for_status()
            result = resp.json()
            log.info("Whisper response: %s", result)
            return result["text"]
