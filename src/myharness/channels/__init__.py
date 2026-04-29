"""MyHarness channels subsystem.

Provides a message-bus architecture for integrating chat platforms
(Telegram, Discord, Slack, etc.) with the MyHarness query engine.

Usage::

    from myharness.channels import BaseChannel, ChannelManager, MessageBus
"""

from myharness.channels.bus.events import InboundMessage, OutboundMessage
from myharness.channels.bus.queue import MessageBus
from myharness.channels.impl.base import BaseChannel
from myharness.channels.impl.manager import ChannelManager

__all__ = [
    "BaseChannel",
    "ChannelManager",
    "InboundMessage",
    "MessageBus",
    "OutboundMessage",
]
