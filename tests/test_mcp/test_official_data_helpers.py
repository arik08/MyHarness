"""Failure-focused tests for shared official-data MCP helpers."""

from __future__ import annotations

import builtins
import json
import ssl
from unittest.mock import MagicMock

import httpx
import pytest

from myharness.mcp import official_data


@pytest.mark.parametrize("first,second", [("", ""), ("value", ""), ("", "value"), ("value", "value"), (" ", "value")])
@pytest.mark.parametrize("require_all", [False, True])
def test_health_distinguishes_credential_aliases_from_required_pairs(monkeypatch, first, second, require_all):
    monkeypatch.setenv("TEST_CLIENT_ID", first)
    monkeypatch.setenv("TEST_CLIENT_SECRET", second)
    configured = all((first.strip(), second.strip())) if require_all else any((first.strip(), second.strip()))
    probe = MagicMock()
    payload = json.loads(official_data.checked_health_envelope(
        source="test", probe=probe, success_detail="connected",
        credential_env=("TEST_CLIENT_ID", "TEST_CLIENT_SECRET"), require_all_credentials=require_all,
    ))
    assert payload["ok"] == configured
    assert payload["credential"]["configured"] == configured
    assert probe.call_count == int(configured)


def _response(status_code: int, *, json_value: object | None = None) -> MagicMock:
    response = MagicMock()
    response.status_code = status_code
    response.headers = {"content-type": "application/json"}
    response.content = b"{}"
    response.text = "{}"
    if status_code >= 400:
        response.raise_for_status.side_effect = httpx.HTTPStatusError(
            "failed",
            request=httpx.Request("GET", "https://example.test"),
            response=httpx.Response(status_code, request=httpx.Request("GET", "https://example.test")),
        )
    else:
        response.raise_for_status.return_value = None
    response.json.return_value = json_value
    return response


def test_first_env_strips_outer_whitespace(monkeypatch) -> None:
    monkeypatch.setenv("OFFICIAL_TEST_KEY", "  value-with-space-inside  ")

    assert official_data.first_env("OFFICIAL_TEST_KEY") == "value-with-space-inside"


def test_no_content_is_empty_only_for_opted_in_sources(monkeypatch):
    monkeypatch.setattr(official_data, "request", lambda *a, **k: httpx.Response(204))
    assert official_data.request_json("Census", "https://example.test", empty_status_codes=(204,)) == []
    with pytest.raises(RuntimeError, match="non-JSON"):
        official_data.request_json("Other", "https://example.test")


def test_shared_rate_slots_keep_credentials_out_of_storage(monkeypatch, tmp_path):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path))
    monkeypatch.setattr(official_data.time, "time", lambda: 100.0)
    sleeps = []
    monkeypatch.setattr(official_data.time, "sleep", sleeps.append)
    headers = {"x-api-key": "private-test-key"}
    official_data._wait_shared_request_slot("source", headers, 5)
    official_data._wait_shared_request_slot("source", headers, 5)
    assert sleeps == [5]
    assert b"private-test-key" not in (tmp_path / "mcp-rate-limits.sqlite3").read_bytes()


def test_pacing_spaces_completed_requests_and_retry_after(monkeypatch):
    now = [100.0]
    starts = []
    sleeps = []
    def sleep(seconds):
        sleeps.append(seconds)
        now[0] += seconds
    def get(*args, **kwargs):
        starts.append(now[0])
        now[0] += 0.4
        return _response(200)
    monkeypatch.setattr(official_data.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(official_data.time, "sleep", sleep)
    monkeypatch.setattr(official_data.httpx, "get", get)
    monkeypatch.setattr(official_data, "_REQUEST_SLOTS", {})
    official_data.request("paced", "https://example.test", minimum_interval=1.1)
    official_data.request("paced", "https://example.test", minimum_interval=1.1)
    assert starts[1] - starts[0] >= 1.5
    responses = [_response(429), _response(200)]
    responses[0].headers["Retry-After"] = "4"
    monkeypatch.setattr(official_data.httpx, "get", lambda *a, **k: responses.pop(0))
    official_data.request("other", "https://example.test")
    assert 4 in sleeps


@pytest.mark.parametrize("encoding", ["utf-8", "cp1252"])
def test_json_encoding_fallback_preserves_source_punctuation(monkeypatch, encoding):
    payload = {"Dataset": [{"Indicator": "Trade – annual", "Value": 12.5}]}
    response = httpx.Response(200, content=json.dumps(payload, ensure_ascii=False).encode(encoding))
    monkeypatch.setattr(official_data, "request", lambda *a, **k: response)
    assert official_data.request_json("WTO", "https://example.test", fallback_encoding="cp1252") == payload
    if encoding == "cp1252":
        with pytest.raises(RuntimeError, match="non-JSON"):
            official_data.request_json("Other source", "https://example.test")


def test_json_encoding_fallback_does_not_accept_malformed_json(monkeypatch):
    response = httpx.Response(200, content=b'{"value": "\x96", broken}')
    monkeypatch.setattr(official_data, "request", lambda *a, **k: response)
    with pytest.raises(RuntimeError, match="non-JSON"):
        official_data.request_json("WTO", "https://example.test", fallback_encoding="cp1252")


def test_health_preserves_http_failure_without_leaking_credentials(monkeypatch) -> None:
    monkeypatch.setattr(official_data.httpx, "get", lambda *args, **kwargs: _response(429))
    monkeypatch.setattr(official_data.time, "sleep", lambda _seconds: None)
    result = json.loads(official_data.checked_health_envelope(
        source="public source",
        probe=lambda: official_data.request("public source", "https://example.test?key=secret-value"),
        success_detail="reachable",
    ))
    assert result["ok"] is False
    assert result["credential"]["required"] is False
    assert "HTTP 429" in result["detail"]
    assert "secret-value" not in json.dumps(result)


def test_get_retries_transient_status_then_succeeds(monkeypatch) -> None:
    responses = [_response(429), _response(503), _response(200)]
    get = MagicMock(side_effect=responses)
    monkeypatch.setattr(official_data.httpx, "get", get)
    monkeypatch.setattr(official_data.time, "sleep", lambda _seconds: None)

    result = official_data.request("Source", "https://example.test", params={"key": "secret"})

    assert result is responses[-1]
    assert get.call_count == 3


def test_get_retries_transient_network_error_then_succeeds(monkeypatch) -> None:
    response = _response(200)
    get = MagicMock(
        side_effect=[
            httpx.ReadTimeout("temporary timeout"),
            response,
        ]
    )
    monkeypatch.setattr(official_data.httpx, "get", get)
    monkeypatch.setattr(official_data.time, "sleep", lambda _seconds: None)

    result = official_data.request("Source", "https://example.test")

    assert result is response
    assert get.call_count == 2


def test_non_json_diagnostic_never_reflects_response_body(monkeypatch) -> None:
    response = _response(200)
    response.content = b"credential=top-secret-value"
    response.text = response.content.decode()
    response.json.side_effect = ValueError("not json")
    monkeypatch.setattr(official_data, "request", lambda *_args, **_kwargs: response)

    with pytest.raises(RuntimeError) as exc_info:
        official_data.request_json("Source", "https://example.test")

    assert "top-secret-value" not in str(exc_info.value)
    assert f"response_bytes={len(response.content)}" in str(exc_info.value)


def test_checked_health_skips_probe_when_credential_is_missing(monkeypatch) -> None:
    monkeypatch.delenv("MISSING_OFFICIAL_KEY", raising=False)
    probe = MagicMock()

    result = json.loads(
        official_data.checked_health_envelope(
            source="Source",
            probe=probe,
            success_detail="reachable",
            credential_env=("MISSING_OFFICIAL_KEY",),
        )
    )

    assert result["ok"] is False
    assert result["credential"]["configured"] is False
    probe.assert_not_called()


def test_checked_health_converts_probe_exception_to_json() -> None:
    def fail() -> None:
        raise TimeoutError("private diagnostic")

    result = json.loads(
        official_data.checked_health_envelope(
            source="Source",
            probe=fail,
            success_detail="reachable",
        )
    )

    assert result["ok"] is False
    assert result["detail"] == "Official endpoint probe failed (TimeoutError)."
    assert "private diagnostic" not in result["detail"]


def test_limit_identifier_and_envelope_validation() -> None:
    assert official_data.clean_limit(0, maximum=10) == 1
    assert official_data.clean_limit(50, maximum=10) == 10
    assert official_data.safe_identifier(" valid-id ", field_name="id") == "valid-id"
    with pytest.raises(ValueError, match="invalid format"):
        official_data.safe_identifier("../invalid", field_name="id")

    result = json.loads(
        official_data.result_envelope(
            source="Source",
            source_id="id",
            data=[1],
            metadata={"page": 1},
        )
    )
    assert result["metadata"] == {"page": 1}


def test_checked_health_success_reports_configured_credential(monkeypatch) -> None:
    monkeypatch.setenv("OFFICIAL_HEALTH_KEY", "configured")
    result = json.loads(
        official_data.checked_health_envelope(
            source="Source",
            probe=lambda: {"ok": True},
            success_detail="reachable",
            credential_env=("OFFICIAL_HEALTH_KEY",),
        )
    )

    assert result["ok"] is True
    assert result["credential"]["configured"] is True


def test_get_stops_on_non_transient_error_without_leaking_query(monkeypatch) -> None:
    response = _response(401)
    get = MagicMock(return_value=response)
    monkeypatch.setattr(official_data.httpx, "get", get)

    with pytest.raises(RuntimeError) as exc_info:
        official_data.request(
            "Source", "https://example.test", params={"api_key": "top-secret"}
        )

    assert get.call_count == 1
    assert "top-secret" not in str(exc_info.value)


def test_post_retries_transient_status_then_succeeds(monkeypatch) -> None:
    responses = [_response(503), _response(200, json_value={"token": "ok"})]
    post = MagicMock(side_effect=responses)
    monkeypatch.setattr(official_data.httpx, "post", post)
    monkeypatch.setattr(official_data.time, "sleep", lambda _seconds: None)

    result = official_data.post_form_json(
        "Source",
        "https://example.test/token",
        data={"grant_type": "client_credentials"},
        auth=("client", "secret"),
    )

    assert result == {"token": "ok"}
    assert post.call_count == 2


def test_post_retries_transient_network_error_then_succeeds(monkeypatch) -> None:
    response = _response(200, json_value={"token": "ok"})
    post = MagicMock(
        side_effect=[
            httpx.ConnectError("temporary connection failure"),
            response,
        ]
    )
    monkeypatch.setattr(official_data.httpx, "post", post)
    monkeypatch.setattr(official_data.time, "sleep", lambda _seconds: None)

    result = official_data.post_form_json(
        "Source",
        "https://example.test/token",
        data={"grant_type": "client_credentials"},
    )

    assert result == {"token": "ok"}
    assert post.call_count == 2


def test_post_parse_failure_is_secret_safe(monkeypatch) -> None:
    response = _response(200)
    response.json.side_effect = ValueError("body contains secret-value")
    monkeypatch.setattr(official_data.httpx, "post", lambda *_args, **_kwargs: response)

    with pytest.raises(RuntimeError) as exc_info:
        official_data.post_form_json(
            "Source",
            "https://example.test/token",
            data={"client_secret": "secret-value"},
        )

    assert "secret-value" not in str(exc_info.value)


def test_tls_fallback_uses_custom_bundle_when_project_helper_is_unavailable(
    monkeypatch,
) -> None:
    real_import = builtins.__import__
    context = MagicMock(spec=ssl.SSLContext)

    def fake_import(name, *args, **kwargs):
        if name == "myharness.utils.certificates":
            raise ImportError("forced fallback")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    monkeypatch.setenv("SSL_CERT_FILE", "C:/certs/corporate.pem")
    monkeypatch.setattr(official_data.ssl, "create_default_context", lambda: context)

    result = official_data.httpx_verify_argument()

    assert result is context
    context.load_verify_locations.assert_called_once_with(
        cafile="C:/certs/corporate.pem"
    )
