"""Message bus module for decoupled channel-agent communication."""

from myharness.channels.bus.events import InboundMessage, OutboundMessage
from myharness.channels.bus.queue import MessageBus

__all__ = ["MessageBus", "InboundMessage", "OutboundMessage"]
