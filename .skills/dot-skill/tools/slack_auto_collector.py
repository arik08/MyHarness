#!/usr/bin/env python3
"""Collect target-authored Slack messages for dot-skill analysis."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

try:
    from slack_sdk import WebClient
    from slack_sdk.errors import SlackApiError
except ImportError:
    print("Error: install slack_sdk first: pip3 install slack-sdk", file=sys.stderr)
    sys.exit(1)

CONFIG_PATH = Path.home() / ".dot-skill" / "slack_config.json"
CHANNEL_TYPES = "public_channel,private_channel,mpim,im"
MAX_RETRIES = 5
RETRY_BASE_WAIT = 1.0
RETRY_MAX_WAIT = 60.0
DEFAULT_MSG_LIMIT = 1000
DEFAULT_CHANNEL_LIMIT = 50


class SlackCollectorError(Exception):
    """Expected collection failure."""


class SlackScopeError(SlackCollectorError):
    """The bot token is missing a required OAuth scope."""


class SlackAuthError(SlackCollectorError):
    """The bot token is invalid or expired."""


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        print("No config found. Run: python3 slack_auto_collector.py --setup", file=sys.stderr)
        sys.exit(1)
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print(f"Config file is invalid. Re-run --setup: {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)


def save_config(config: dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")


def setup_config() -> None:
    print("=== Slack Collection Setup ===\n")
    print("1. Go to https://api.slack.com/apps and create an app from scratch.")
    print("2. Add Bot Token Scopes: channels:read, channels:history, groups:read, groups:history, users:read.")
    print("3. Optional scopes: im:read, im:history, mpim:read, mpim:history.")
    print("4. Install the app to the workspace and copy the Bot User OAuth Token.")
    print("5. Invite the bot to channels you want to collect from.\n")
    token = input("Bot User OAuth Token (xoxb-...): ").strip()
    if not token.startswith("xoxb-"):
        print("Warning: bot tokens usually start with xoxb-", file=sys.stderr)

    print("\nValidating token ...", end=" ", flush=True)
    try:
        client = WebClient(token=token)
        resp = client.auth_test()
        print(f"OK\n  Workspace: {resp.get('team', 'Unknown')}\n  Bot: {resp.get('user', 'Unknown')}")
    except SlackApiError as exc:
        error = exc.response.get("error", str(exc))
        print(f"failed: {error}", file=sys.stderr)
        sys.exit(1)

    save_config({"bot_token": token})
    print(f"\nSaved config to {CONFIG_PATH}")


class RateLimitedClient:
    """Small Slack WebClient wrapper with retry handling for 429 responses."""

    def __init__(self, token: str) -> None:
        self._client = WebClient(token=token)

    def call(self, method: str, **kwargs) -> dict:
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                return getattr(self._client, method)(**kwargs).data
            except SlackApiError as exc:
                error = exc.response.get("error", "")
                if error == "ratelimited":
                    wait = float(exc.response.headers.get("Retry-After", RETRY_BASE_WAIT * attempt))
                    wait = min(wait, RETRY_MAX_WAIT)
                    print(f"  Rate limited; waiting {wait:.0f}s ({attempt}/{MAX_RETRIES})...", file=sys.stderr)
                    time.sleep(wait)
                    continue
                if error == "missing_scope":
                    missing = exc.response.get("needed", "unknown")
                    raise SlackScopeError(f"Bot token is missing scope: {missing}") from exc
                if error in {"invalid_auth", "token_revoked", "account_inactive"}:
                    raise SlackAuthError(f"Slack auth failed: {error}. Re-run --setup.") from exc
                if error in {"not_in_channel", "channel_not_found"}:
                    raise
                print(f"  Slack API warning from {method}: {error}", file=sys.stderr)
                return {}
        print(f"  Slack API call failed after retries: {method}", file=sys.stderr)
        return {}

    def paginate(self, method: str, result_key: str, **kwargs) -> list:
        items: list = []
        cursor = None
        while True:
            params = dict(kwargs)
            if cursor:
                params["cursor"] = cursor
            data = self.call(method, **params)
            if not data:
                break
            items.extend(data.get(result_key, []))
            cursor = data.get("response_metadata", {}).get("next_cursor")
            if not cursor:
                break
        return items


def find_user(name: str, client: RateLimitedClient) -> Optional[dict]:
    """Find a Slack user by username, display name, or real name."""
    print(f"  Searching Slack users for: {name}", file=sys.stderr)
    members = client.paginate("users_list", "members", limit=200)
    members = [m for m in members if not m.get("is_bot") and not m.get("deleted") and m.get("id") != "USLACKBOT"]
    needle = name.lower()

    def score(member: dict) -> int:
        profile = member.get("profile", {})
        fields = [
            profile.get("real_name") or "",
            profile.get("display_name") or "",
            member.get("name") or "",
        ]
        lowered = [field.lower() for field in fields]
        if needle in lowered:
            return 3
        if any(needle in field for field in lowered):
            return 2
        return 0

    candidates = [(score(m), m) for m in members]
    candidates = [(s, m) for s, m in candidates if s > 0]
    candidates.sort(key=lambda item: -item[0])
    if not candidates:
        print(f"  No Slack user found for: {name}", file=sys.stderr)
        return None
    if len(candidates) > 1:
        print(f"  Multiple matches found; using the best match out of {len(candidates)}.", file=sys.stderr)
    user = candidates[0][1]
    profile = user.get("profile", {})
    print(f"  Found user: {profile.get('real_name') or user.get('name')} (@{profile.get('display_name') or user.get('name')})", file=sys.stderr)
    return user


def get_channels_with_user(user_id: str, channel_limit: int, client: RateLimitedClient) -> list:
    """Return channels that contain both the bot and the target user."""
    print("  Loading channel list ...", file=sys.stderr)
    channels = client.paginate("conversations_list", "channels", types=CHANNEL_TYPES, exclude_archived=True, limit=200)
    bot_channels = [c for c in channels if c.get("is_member")]
    if len(bot_channels) > channel_limit:
        print(f"  Channel count exceeds limit; checking first {channel_limit} channels.", file=sys.stderr)
        bot_channels = bot_channels[:channel_limit]

    result: list = []
    for channel in bot_channels:
        channel_id = channel.get("id", "")
        channel_name = channel.get("name", channel_id)
        try:
            members = client.paginate("conversations_members", "members", channel=channel_id, limit=200)
        except SlackApiError as exc:
            error = exc.response.get("error", "")
            print(f"    Skipping #{channel_name}: {error}", file=sys.stderr)
            continue
        if user_id in members:
            result.append(channel)
            print(f"    matched #{channel_name}", file=sys.stderr)
    return result


def fetch_messages_from_channel(channel_id: str, channel_name: str, user_id: str, limit: int, client: RateLimitedClient) -> list:
    """Fetch target-authored messages from a Slack channel."""
    messages: list = []
    cursor = None
    pages = 0
    while len(messages) < limit and pages < 50:
        params = {"channel": channel_id, "limit": 200}
        if cursor:
            params["cursor"] = cursor
        try:
            data = client.call("conversations_history", **params)
        except SlackApiError as exc:
            print(f"    Could not read #{channel_name}: {exc.response.get('error', '')}", file=sys.stderr)
            break
        if not data:
            break
        pages += 1
        for msg in data.get("messages", []):
            if msg.get("user") != user_id or msg.get("subtype"):
                continue
            text = msg.get("text", "").strip()
            if not text or _is_noise(text):
                continue
            messages.append({
                "content": text,
                "time": _format_ts(msg.get("ts", "")),
                "channel": channel_name,
                "is_thread_starter": bool(msg.get("reply_count", 0)),
            })
        cursor = data.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            break
    return messages[:limit]


def _is_noise(text: str) -> bool:
    cleaned = re.sub(r"<[^>]+>", "", text).strip()
    cleaned = re.sub(r":[a-z_]+:", "", cleaned).strip()
    return len(cleaned) < 2


def _format_ts(ts: str) -> str:
    try:
        return datetime.fromtimestamp(float(ts)).strftime("%Y-%m-%d %H:%M")
    except (ValueError, OSError):
        return ts


def collect_messages(user: dict, channels: list, msg_limit: int, client: RateLimitedClient) -> str:
    """Collect and format target-authored Slack messages."""
    user_id = user["id"]
    name = user.get("profile", {}).get("real_name") or user.get("name", user_id)
    if not channels:
        return f"# Slack Message Records\n\nNo shared bot-visible channels were found for {name}. Invite the bot to relevant channels and try again.\n"

    all_messages: list = []
    per_channel_limit = max(100, msg_limit // len(channels))
    for channel in channels:
        channel_id = channel.get("id", "")
        channel_name = channel.get("name", channel_id)
        print(f"  Reading #{channel_name} ...", file=sys.stderr)
        messages = fetch_messages_from_channel(channel_id, channel_name, user_id, per_channel_limit, client)
        all_messages.extend(messages)
        print(f"    collected {len(messages)} message(s)", file=sys.stderr)

    thread_messages = [m for m in all_messages if m["is_thread_starter"]]
    long_messages = [m for m in all_messages if not m["is_thread_starter"] and len(m["content"]) > 50]
    short_messages = [m for m in all_messages if not m["is_thread_starter"] and len(m["content"]) <= 50]
    channel_names = ", ".join(f"#{c.get('name', c.get('id', ''))}" for c in channels)

    lines = [
        "# Slack Message Records",
        f"Target: {name}",
        f"Source channels: {channel_names}",
        f"Total messages: {len(all_messages)}",
        f"Thread starters: {len(thread_messages)}",
        f"Long messages: {len(long_messages)}",
        f"Short messages: {len(short_messages)}",
        "",
        "---",
        "",
        "## Thread Starters",
        "",
    ]
    for item in thread_messages:
        lines += [f"[{item['time']}][#{item['channel']}] {item['content']}", ""]
    lines += ["---", "", "## Long Messages", ""]
    for item in long_messages:
        lines += [f"[{item['time']}][#{item['channel']}] {item['content']}", ""]
    lines += ["---", "", "## Daily Communication Samples", ""]
    for item in short_messages[:300]:
        lines.append(f"[{item['time']}] {item['content']}")
    return "\n".join(lines)


def collect_all(name: str, output_dir: Path, msg_limit: int, channel_limit: int, config: dict) -> dict:
    """Collect Slack data and write output files."""
    output_dir.mkdir(parents=True, exist_ok=True)
    client = RateLimitedClient(config["bot_token"])
    auth_data = client.call("auth_test")
    if not auth_data:
        raise SlackAuthError("auth_test did not return a valid response")
    print(f"Workspace: {auth_data.get('team')} | Bot: {auth_data.get('user')}", file=sys.stderr)

    user = find_user(name, client)
    if not user:
        raise SlackCollectorError(f"No Slack user found for {name}")
    profile = user.get("profile", {})
    real_name = profile.get("real_name") or user.get("name", user["id"])
    channels = get_channels_with_user(user["id"], channel_limit, client)
    content = collect_messages(user, channels, msg_limit, client)

    messages_path = output_dir / "messages.txt"
    messages_path.write_text(content, encoding="utf-8")
    summary = {
        "name": real_name,
        "slack_user_id": user["id"],
        "display_name": profile.get("display_name", ""),
        "title": profile.get("title", ""),
        "channels": [{"id": c.get("id"), "name": c.get("name")} for c in channels],
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "files": {"messages": str(messages_path)},
        "note": "Slack free workspaces may only retain recent message history.",
    }
    summary_path = output_dir / "collection_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"Wrote messages to {messages_path}", file=sys.stderr)
    print(f"Wrote summary to {summary_path}", file=sys.stderr)
    return {"messages": str(messages_path), "summary": str(summary_path)}


def main() -> None:
    parser = argparse.ArgumentParser(description="Collect Slack messages for dot-skill analysis")
    parser.add_argument("--setup", action="store_true", help="Configure Slack Bot Token")
    parser.add_argument("--name", help="Target Slack user name, display name, or username")
    parser.add_argument("--output-dir", default=None, help="Output directory; defaults to ./knowledge/{name}")
    parser.add_argument("--msg-limit", type=int, default=DEFAULT_MSG_LIMIT, help=f"Maximum messages to collect (default {DEFAULT_MSG_LIMIT})")
    parser.add_argument("--channel-limit", type=int, default=DEFAULT_CHANNEL_LIMIT, help=f"Maximum channels to inspect (default {DEFAULT_CHANNEL_LIMIT})")
    args = parser.parse_args()

    if args.setup:
        setup_config()
        return
    if not args.name:
        parser.error("Please provide --name")

    output_dir = Path(args.output_dir) if args.output_dir else Path("./knowledge") / args.name
    try:
        collect_all(args.name, output_dir, args.msg_limit, args.channel_limit, load_config())
    except SlackCollectorError as exc:
        print(f"Collection failed: {exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("Cancelled", file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()
