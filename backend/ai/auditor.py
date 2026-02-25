"""AI auditor — Claude-powered natural language auditing."""

from __future__ import annotations

import logging
import os

from anthropic import AsyncAnthropic

log = logging.getLogger("mindscope.ai_auditor")

SYSTEM_PROMPT = """\
You are an AI auditor conducting a one-on-one session with a person (referred to as "PC" — the person being audited). You guide the session using a structured protocol while reading real-time E-Meter data to track their mental and emotional state.

## Your Role

- You are calm, professional, warm, and non-judgmental
- You ask questions, acknowledge the PC's responses, and follow the charge (emotional reactivity shown on the meter)
- You NEVER interpret, evaluate, or give advice — you guide the PC to look at things for themselves
- You maintain a neutral, interested tone at all times

## E-Meter Basics

The meter measures galvanic skin response (resistance changes). You will receive structured data with each turn:

**Needle Actions** — what matters most:
- **Fall / Long Fall / Blowdown**: Charge being released. Good sign — explore further.
- **Floating Needle (F/N)**: Gentle rhythmic oscillation. Release point — acknowledge and move on.
- **Rise / Speeded Rise**: Protest or disagreement. Back off or adjust.
- **Rock Slam**: Extreme charge. Handle with care.
- **Stuck**: PC not in communication. Rephrase or reconnect.
- **Dirty Needle**: Unresolved charge nearby.

## Response Rules

1. **Keep responses to 1-3 sentences maximum.** Ask questions, not speeches.
2. **Ask ONE question per turn.** Never stack multiple questions.
3. **Acknowledge before asking.** Briefly acknowledge the PC's response before your next question.
4. **Follow the charge.** If the meter shows a read, explore it.
5. **Respect the F/N.** When a floating needle appears, acknowledge and move on.
6. **Never invalidate.** Accept whatever the PC says.
7. **Stay in role.** You are conducting a session, not having a casual conversation.

Respond with your next auditor statement or question. Nothing else — no metadata, no explanations, just your in-session response."""

MAX_HISTORY = 80
MODEL = "claude-sonnet-4-20250514"


class AIAuditor:
    """Claude-powered auditor that generates natural language responses."""

    def __init__(self, client: AsyncAnthropic) -> None:
        self._client = client
        self._history: list[dict] = []

    @staticmethod
    def create() -> AIAuditor | None:
        """Factory: returns None if no ANTHROPIC_API_KEY."""
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            log.info("AI auditor disabled — no ANTHROPIC_API_KEY")
            return None
        client = AsyncAnthropic(api_key=api_key)
        log.info("AI auditor enabled")
        return AIAuditor(client)

    def reset(self) -> None:
        """Clear conversation history for a new session."""
        self._history.clear()
        log.info("AI auditor history reset")

    def _build_user_message(
        self,
        pc_text: str,
        r3r_state: str,
        r3r_command: str,
        meter_data: dict | None,
        session_info: dict | None,
    ) -> str:
        """Format the structured payload for the AI."""
        parts = []

        # Meter data
        if meter_data:
            ta = meter_data.get("toneArm", 2.0)
            action = meter_data.get("needleAction", "idle")
            sensitivity = meter_data.get("sensitivity", 16)
            parts.append(
                f"[METER DATA]\nTA: {ta:.2f}\nNeedle Action: {action}\nSensitivity: {sensitivity}"
            )

        # Session info
        if session_info:
            phase = session_info.get("phase", "PROCESSING")
            elapsed = session_info.get("elapsed", 0)
            minutes = int(elapsed) // 60
            seconds = int(elapsed) % 60
            turn = session_info.get("turnNumber", 0)
            parts.append(
                f"[SESSION]\nPhase: {phase}\nDuration: {minutes}m {seconds}s\n"
                f"Exchanges: {turn}\nR3R State: {r3r_state}\nR3R Command: {r3r_command}"
            )

        # PC statement
        parts.append(f"[PC STATEMENT]\n{pc_text}")

        return "\n\n".join(parts)

    async def respond(
        self,
        pc_text: str,
        r3r_state: str,
        r3r_command: str,
        meter_data: dict | None = None,
        session_info: dict | None = None,
    ) -> str:
        """Generate an AI auditor response. Returns the response text."""
        user_msg = self._build_user_message(
            pc_text, r3r_state, r3r_command, meter_data, session_info
        )
        self._history.append({"role": "user", "content": user_msg})

        # Trim history if too long
        if len(self._history) > MAX_HISTORY:
            self._history = self._history[-MAX_HISTORY:]

        response = await self._client.messages.create(
            model=MODEL,
            max_tokens=256,
            system=SYSTEM_PROMPT,
            messages=self._history,
        )

        text = response.content[0].text
        self._history.append({"role": "assistant", "content": text})

        return text
