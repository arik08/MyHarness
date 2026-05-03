import base64
import json

from myharness.api.pgpt_auth import (
    build_pgpt_auth_token,
    resolve_pgpt_company_code,
    resolve_pgpt_employee_no,
)


def test_build_pgpt_auth_token_uses_openai_compatible_payload_keys():
    token = build_pgpt_auth_token("api-key", "E12345", "30")
    payload = json.loads(base64.b64decode(token).decode("utf-8"))

    assert payload == {
        "apiKey": "api-key",
        "companyCode": "30",
        "systemCode": "E12345",
    }


def test_pgpt_employee_and_company_codes_fall_back_to_credentials_file(tmp_path, monkeypatch):
    from myharness.auth.storage import store_credential

    monkeypatch.delenv("PGPT_EMPLOYEE_NO", raising=False)
    monkeypatch.delenv("PGPT_SYSTEM_CODE", raising=False)
    monkeypatch.delenv("POSCO_EMP_NO", raising=False)
    monkeypatch.delenv("PGPT_COMPANY_CODE", raising=False)
    monkeypatch.delenv("POSCO_COMP_NO", raising=False)
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path))
    store_credential("pgpt", "employee_no", "612345", use_keyring=False)
    store_credential("pgpt", "company_code", "31", use_keyring=False)

    assert resolve_pgpt_employee_no() == "612345"
    assert resolve_pgpt_company_code() == "31"
