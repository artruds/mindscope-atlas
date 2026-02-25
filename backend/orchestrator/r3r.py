"""R3R state machine — 17 states, 3 flows for auditing processing."""

from enum import Enum
from dataclasses import dataclass, field


class R3RState(Enum):
    """17 processing states."""
    LOCATE_INCIDENT = "LOCATE_INCIDENT"
    WHAT_HAPPENED = "WHAT_HAPPENED"
    MOVE_THROUGH = "MOVE_THROUGH"
    DURATION = "DURATION"
    BEGINNING = "BEGINNING"
    MOVE_THROUGH_AGAIN = "MOVE_THROUGH_AGAIN"
    WHATS_HAPPENING = "WHATS_HAPPENING"
    ANYTHING_ADDED = "ANYTHING_ADDED"
    TELL_ME_ABOUT = "TELL_ME_ABOUT"
    # A-B-C-D cycle
    ABCD_A_RECALL = "ABCD_A_RECALL"
    ABCD_B_WHEN = "ABCD_B_WHEN"
    ABCD_C_WHAT_DID_YOU_DO = "ABCD_C_WHAT_DID_YOU_DO"
    ABCD_D_ANYTHING_ELSE = "ABCD_D_ANYTHING_ELSE"
    ABCD_ERASING_OR_SOLID = "ABCD_ERASING_OR_SOLID"
    # End phenomena
    EARLIER_SIMILAR = "EARLIER_SIMILAR"
    CHAIN_EP = "CHAIN_EP"
    CHECK_NEXT_FLOW = "CHECK_NEXT_FLOW"
    ITEM_COMPLETE = "ITEM_COMPLETE"


class Flow(Enum):
    """Three flows of R3R."""
    FLOW_1 = 1  # "to you"
    FLOW_2 = 2  # "you to another"
    FLOW_3 = 3  # "others to others"


# Command templates per state per flow
FLOW_LABELS = {
    Flow.FLOW_1: "done to you",
    Flow.FLOW_2: "you did to another",
    Flow.FLOW_3: "another did to others",
}

COMMANDS: dict[R3RState, str] = {
    R3RState.LOCATE_INCIDENT: "Locate an incident of {flow_label}.",
    R3RState.WHAT_HAPPENED: "What happened?",
    R3RState.MOVE_THROUGH: "Move through the incident to a point {duration} later.",
    R3RState.DURATION: "What is the duration of that incident?",
    R3RState.BEGINNING: "Move to the beginning of that incident.",
    R3RState.MOVE_THROUGH_AGAIN: "Move through to the end of that incident.",
    R3RState.WHATS_HAPPENING: "What's happening?",
    R3RState.ANYTHING_ADDED: "Is anything being added to that incident?",
    R3RState.TELL_ME_ABOUT: "Tell me about that.",
    R3RState.ABCD_A_RECALL: "Recall the incident.",
    R3RState.ABCD_B_WHEN: "When was it?",
    R3RState.ABCD_C_WHAT_DID_YOU_DO: "What did you do?",
    R3RState.ABCD_D_ANYTHING_ELSE: "Is there anything else about that incident?",
    R3RState.ABCD_ERASING_OR_SOLID: "Is that incident erasing or going more solid?",
    R3RState.EARLIER_SIMILAR: "Is there an earlier similar incident?",
    R3RState.CHAIN_EP: "How does it seem to you now?",
    R3RState.CHECK_NEXT_FLOW: "Good. Let's check another flow.",
    R3RState.ITEM_COMPLETE: "Very good.",
}

# Initial 9-step sequence before A-B-C-D cycling
INITIAL_SEQUENCE = [
    R3RState.LOCATE_INCIDENT,
    R3RState.WHAT_HAPPENED,
    R3RState.DURATION,
    R3RState.BEGINNING,
    R3RState.MOVE_THROUGH,
    R3RState.WHATS_HAPPENING,
    R3RState.MOVE_THROUGH_AGAIN,
    R3RState.ANYTHING_ADDED,
    R3RState.TELL_ME_ABOUT,
]


@dataclass
class R3RContext:
    """Tracks state within the R3R process."""
    current_flow: Flow = Flow.FLOW_1
    abcd_count: int = 0        # how many A-B-C-D cycles on current incident
    chain_depth: int = 0       # how many earlier-similar incidents deep
    fn_detected: bool = False  # floating needle detected
    cognition_noted: bool = False
    vgis_present: bool = False
    flows_completed: list[Flow] = field(default_factory=list)


class R3RStateMachine:
    """Drives the R3R auditing process through 17 states and 3 flows."""

    def __init__(self) -> None:
        self.state = R3RState.LOCATE_INCIDENT
        self.ctx = R3RContext()
        self._initial_step = 0  # position in initial 9-step sequence
        self._in_initial_sequence = True
        self._duration_value: str = ""

    def get_command(self) -> str:
        """Get the auditor command text for the current state."""
        template = COMMANDS.get(self.state, "")
        flow_label = FLOW_LABELS.get(self.ctx.current_flow, "")
        duration = self._duration_value or "the end"
        return template.format(flow_label=flow_label, duration=duration)

    def transition(
        self,
        pc_response: str = "",
        fn_detected: bool = False,
        cognition: bool = False,
        vgis: bool = False,
    ) -> tuple[R3RState, str]:
        """Advance state based on PC response and meter indicators.

        Returns (new_state, command_text).
        """
        # Update EP indicators
        if fn_detected:
            self.ctx.fn_detected = True
        if cognition:
            self.ctx.cognition_noted = True
        if vgis:
            self.ctx.vgis_present = True

        # --- Initial 9-step sequence ---
        if self._in_initial_sequence:
            self._initial_step += 1
            if self._initial_step < len(INITIAL_SEQUENCE):
                self.state = INITIAL_SEQUENCE[self._initial_step]
                # Capture duration for MOVE_THROUGH command
                if self.state == R3RState.DURATION:
                    pass  # Will be answered by PC
                if INITIAL_SEQUENCE[self._initial_step - 1] == R3RState.DURATION:
                    self._duration_value = pc_response.strip() or "the end"
            else:
                # Transition to A-B-C-D cycle
                self._in_initial_sequence = False
                self.state = R3RState.ABCD_A_RECALL
            return self.state, self.get_command()

        # --- A-B-C-D cycle ---
        if self.state == R3RState.ABCD_A_RECALL:
            self.state = R3RState.ABCD_B_WHEN
            return self.state, self.get_command()

        if self.state == R3RState.ABCD_B_WHEN:
            self.state = R3RState.ABCD_C_WHAT_DID_YOU_DO
            return self.state, self.get_command()

        if self.state == R3RState.ABCD_C_WHAT_DID_YOU_DO:
            self.state = R3RState.ABCD_D_ANYTHING_ELSE
            return self.state, self.get_command()

        if self.state == R3RState.ABCD_D_ANYTHING_ELSE:
            self.ctx.abcd_count += 1
            self.state = R3RState.ABCD_ERASING_OR_SOLID
            return self.state, self.get_command()

        if self.state == R3RState.ABCD_ERASING_OR_SOLID:
            response_lower = pc_response.strip().lower()
            if "erasing" in response_lower or "lighter" in response_lower:
                # Repeat A-B-C-D
                self.state = R3RState.ABCD_A_RECALL
                return self.state, self.get_command()
            else:
                # "solid" or "more solid" → earlier similar
                self.state = R3RState.EARLIER_SIMILAR
                return self.state, self.get_command()

        # --- Earlier similar ---
        if self.state == R3RState.EARLIER_SIMILAR:
            response_lower = pc_response.strip().lower()
            if "yes" in response_lower:
                # Go deeper in chain
                self.ctx.chain_depth += 1
                self.ctx.abcd_count = 0
                self._in_initial_sequence = True
                self._initial_step = 0
                self.state = INITIAL_SEQUENCE[0]
                return self.state, self.get_command()
            else:
                # No earlier similar — check for EP
                return self._check_ep()

        # --- EP check ---
        if self.state == R3RState.CHAIN_EP:
            return self._check_next_flow()

        if self.state == R3RState.CHECK_NEXT_FLOW:
            return self._advance_flow()

        if self.state == R3RState.ITEM_COMPLETE:
            # Reset for new item
            self.reset_for_new_item()
            return self.state, self.get_command()

        # Fallback
        return self.state, self.get_command()

    def _check_ep(self) -> tuple[R3RState, str]:
        """Check if end phenomena conditions are met."""
        if self.ctx.fn_detected and self.ctx.cognition_noted and self.ctx.vgis_present:
            self.state = R3RState.CHAIN_EP
            return self.state, self.get_command()
        # Not full EP — ask the question anyway
        self.state = R3RState.CHAIN_EP
        return self.state, self.get_command()

    def _check_next_flow(self) -> tuple[R3RState, str]:
        """After EP on current flow, check if more flows needed."""
        self.ctx.flows_completed.append(self.ctx.current_flow)

        if self.ctx.current_flow == Flow.FLOW_1 and Flow.FLOW_2 not in self.ctx.flows_completed:
            self.state = R3RState.CHECK_NEXT_FLOW
            return self.state, self.get_command()
        if self.ctx.current_flow == Flow.FLOW_2 and Flow.FLOW_3 not in self.ctx.flows_completed:
            self.state = R3RState.CHECK_NEXT_FLOW
            return self.state, self.get_command()

        # All flows done
        self.state = R3RState.ITEM_COMPLETE
        return self.state, self.get_command()

    def _advance_flow(self) -> tuple[R3RState, str]:
        """Move to the next flow."""
        if Flow.FLOW_2 not in self.ctx.flows_completed:
            self.ctx.current_flow = Flow.FLOW_2
        elif Flow.FLOW_3 not in self.ctx.flows_completed:
            self.ctx.current_flow = Flow.FLOW_3
        else:
            self.state = R3RState.ITEM_COMPLETE
            return self.state, self.get_command()

        # Reset for new flow
        self.ctx.fn_detected = False
        self.ctx.cognition_noted = False
        self.ctx.vgis_present = False
        self.ctx.abcd_count = 0
        self.ctx.chain_depth = 0
        self._in_initial_sequence = True
        self._initial_step = 0
        self.state = INITIAL_SEQUENCE[0]
        return self.state, self.get_command()

    def note_cognition(self) -> None:
        """Mark that a cognition was noted."""
        self.ctx.cognition_noted = True

    def note_vgis(self) -> None:
        """Mark that VGIs are present."""
        self.ctx.vgis_present = True

    def reset_for_new_item(self) -> None:
        """Reset state machine for a new item."""
        self.ctx = R3RContext()
        self._in_initial_sequence = True
        self._initial_step = 0
        self._duration_value = ""
        self.state = R3RState.LOCATE_INCIDENT
