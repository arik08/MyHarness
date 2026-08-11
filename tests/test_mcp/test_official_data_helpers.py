"""Failure-focused tests for shared official-data MCP helpers."""

from __future__ import annotations

import builtins
import json
import ssl
from unittest.mock import MagicMock

import httpx
import pytest

from myharness.mcp import official_data


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
