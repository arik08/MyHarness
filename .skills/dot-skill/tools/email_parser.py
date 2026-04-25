#!/usr/bin/env python3
"""Extract target-authored messages from .eml, .mbox, or text email exports."""

from __future__ import annotations

import argparse
import email
import email.policy
import mailbox
import re
import sys
from email.header import decode_header
from html.parser import HTMLParser
from pathlib import Path


class HTMLTextExtractor(HTMLParser):
    """Extract readable text from HTML email bodies."""

    def __init__(self) -> None:
        super().__init__()
        self.result: list[str] = []
        self._skip = False

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in {"script", "style"}:
            self._skip = True

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"}:
            self._skip = False
        if tag in {"p", "br", "div", "tr"}:
            self.result.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self.result.append(data)

    def get_text(self) -> str:
        return re.sub(r"\n{3,}", "\n\n", "".join(self.result)).strip()


def decode_mime_str(value: str) -> str:
    """Decode MIME-encoded header text."""
    if not value:
        return ""
    decoded: list[str] = []
    for part, charset in decode_header(value):
        if isinstance(part, bytes):
            decoded.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            decoded.append(str(part))
    return "".join(decoded)


def extract_email_body(msg) -> str:
    """Extract the best available body text from an email message."""
    body = ""
    if msg.is_multipart():
        html_body = ""
        for part in msg.walk():
            content_type = part.get_content_type()
            disposition = str(part.get("Content-Disposition", ""))
            if "attachment" in disposition:
                continue
            payload = part.get_payload(decode=True)
            if not payload:
                continue
            charset = part.get_content_charset() or "utf-8"
            text = payload.decode(charset, errors="replace")
            if content_type == "text/plain":
                body = text
                break
            if content_type == "text/html" and not html_body:
                extractor = HTMLTextExtractor()
                extractor.feed(text)
                html_body = extractor.get_text()
        if not body:
            body = html_body
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or "utf-8"
            body = payload.decode(charset, errors="replace")

    body = re.sub(r"\n>.*", "", body)
    body = re.sub(r"\n_{3,}\n.*", "", body, flags=re.DOTALL)
    return body.strip()


def is_from_target(from_field: str, target: str) -> bool:
    """Return true when the From header appears to match the target."""
    return target.lower() in decode_mime_str(from_field).lower()


def parse_eml_file(file_path: str, target: str) -> list[dict]:
    """Parse one .eml file."""
    with open(file_path, "rb") as handle:
        msg = email.message_from_binary_file(handle, policy=email.policy.default)
    from_field = str(msg.get("From", ""))
    if not is_from_target(from_field, target):
        return []
    body = extract_email_body(msg)
    if not body:
        return []
    return [{
        "from": decode_mime_str(from_field),
        "subject": decode_mime_str(str(msg.get("Subject", ""))),
        "date": str(msg.get("Date", "")),
        "body": body,
    }]


def parse_mbox_file(file_path: str, target: str) -> list[dict]:
    """Parse an .mbox archive."""
    results: list[dict] = []
    for msg in mailbox.mbox(file_path):
        from_field = str(msg.get("From", ""))
        if not is_from_target(from_field, target):
            continue
        body = extract_email_body(msg)
        if body:
            results.append({
                "from": decode_mime_str(from_field),
                "subject": decode_mime_str(str(msg.get("Subject", ""))),
                "date": str(msg.get("Date", "")),
                "body": body,
            })
    return results


def parse_txt_file(file_path: str, target: str) -> list[dict]:
    """Parse a simple text export with From, Subject, and Date headers."""
    content = Path(file_path).read_text(encoding="utf-8", errors="replace")
    chunks = re.split(r"\n={3,}\n|\n-{3,}\n(?=From:)", content)
    results: list[dict] = []
    for raw in chunks:
        from_match = re.search(r"^From:\s*(.+)$", raw, re.MULTILINE)
        if not from_match or not is_from_target(from_match.group(1), target):
            continue
        subject_match = re.search(r"^Subject:\s*(.+)$", raw, re.MULTILINE)
        date_match = re.search(r"^Date:\s*(.+)$", raw, re.MULTILINE)
        body = re.sub(r"^(From|To|Subject|Date|CC|BCC):.*\n?", "", raw, flags=re.MULTILINE).strip()
        if body:
            results.append({
                "from": from_match.group(1).strip(),
                "subject": subject_match.group(1).strip() if subject_match else "",
                "date": date_match.group(1).strip() if date_match else "",
                "body": body,
            })
    return results


def classify_emails(emails: list[dict]) -> dict:
    """Group emails by likely analytical value."""
    decision_keywords = [
        "approve", "reject", "lgtm", "recommend", "suggest", "decide",
        "decision", "proposal", "tradeoff", "must", "should", "risk",
        "blocker", "priority", "confirm", "agree", "disagree",
    ]
    long_emails: list[dict] = []
    decision_emails: list[dict] = []
    daily_emails: list[dict] = []
    for item in emails:
        body = item["body"]
        lowered = body.lower()
        if len(body) > 200:
            long_emails.append(item)
        elif any(keyword in lowered for keyword in decision_keywords):
            decision_emails.append(item)
        else:
            daily_emails.append(item)
    return {
        "long_emails": long_emails,
        "decision_emails": decision_emails,
        "daily_emails": daily_emails,
        "total_count": len(emails),
    }


def format_output(target: str, classified: dict) -> str:
    """Format extracted emails for dot-skill analysis."""
    lines = [
        "# Email Extraction Results",
        f"Target: {target}",
        f"Total messages: {classified['total_count']}",
        "",
        "---",
        "",
        "## Long Emails (highest value for work style and reasoning)",
        "",
    ]
    for item in classified["long_emails"]:
        lines += [f"**Subject: {item['subject']}** [{item['date']}]", item["body"], "", "---", ""]
    lines += ["## Decision Emails", ""]
    for item in classified["decision_emails"]:
        lines += [f"**Subject: {item['subject']}** [{item['date']}]", item["body"], ""]
    lines += ["---", "", "## Daily Communication Samples", ""]
    for item in classified["daily_emails"][:30]:
        lines += [f"**{item['subject']}**: {item['body'][:200]}", ""]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract target-authored emails for dot-skill analysis")
    parser.add_argument("--file", required=True, help="Input file path (.eml, .mbox, or .txt)")
    parser.add_argument("--target", required=True, help="Target name or email address")
    parser.add_argument("--output", default=None, help="Output file path; defaults to stdout")
    args = parser.parse_args()

    file_path = Path(args.file)
    if not file_path.exists():
        print(f"Error: file does not exist: {file_path}", file=sys.stderr)
        sys.exit(1)

    suffix = file_path.suffix.lower()
    if suffix == ".eml":
        emails = parse_eml_file(str(file_path), args.target)
    elif suffix == ".mbox":
        emails = parse_mbox_file(str(file_path), args.target)
    else:
        emails = parse_txt_file(str(file_path), args.target)

    if not emails:
        print(f"Warning: no emails found from '{args.target}'.", file=sys.stderr)
        print("Check that the target matches the From header.", file=sys.stderr)

    output = format_output(args.target, classify_emails(emails))
    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
        print(f"Wrote {len(emails)} email(s) to {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
