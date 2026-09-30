import pytest

from myharness.config.settings import Settings, load_settings, save_settings
from myharness.runtime_catalog import _runtime_picker_options


def test_policy_preserves_catalog_filters_choices_and_restores_disabled_selection(tmp_path):
    settings = Settings()
    name, profile = settings.resolve_profile()
    original, enabled = profile.allowed_models[:2]
    settings.enabled_models_by_profile = {name: [enabled]}
    settings = settings.materialize_active_profile()
    assert settings.model == enabled
    assert settings.resolve_profile()[1].allowed_models == [enabled]
    with pytest.raises(ValueError):
        settings.resolve_profile()[1].require_model(original, profile_name=name)
    assert settings.merge_cli_overrides(model=original).model == enabled
    assert settings.merge_cli_overrides(active_profile=name, model=original).model == enabled
    options = _runtime_picker_options(settings)
    assert [m['value'] for m in options['models_by_provider'][name]] == [enabled]
    assert original in [m['value'] for m in options['all_models_by_provider'][name]]
    path = tmp_path / 'settings.json'
    save_settings(settings, path)
    restored = load_settings(path)
    assert restored.enabled_models_by_profile == {name: [enabled]}
    assert restored.model == enabled


def test_unknown_and_new_models_are_not_implicitly_enabled():
    settings = Settings()
    name, profile = settings.resolve_profile()
    settings.enabled_models_by_profile = {name: profile.allowed_models[:1]}
    restricted = settings.resolve_profile()[1]
    assert not restricted.allows_model('brand-new-model')
    with pytest.raises(ValueError):
        restricted.require_model('brand-new-model')
    settings.enabled_models_by_profile[name] = []
    with pytest.raises(ValueError, match='허용된 모델이 없습니다'):
        settings.resolve_profile(name)


def test_model_policy_is_provider_scoped():
    settings = Settings()
    profiles = settings.merged_profiles()
    first, second = list(profiles)[:2]
    settings.enabled_models_by_profile = {first: profiles[first].allowed_models[:1]}
    assert settings.resolve_profile(second)[1].allowed_models == profiles[second].allowed_models


def test_admin_catalog_remains_available_when_all_models_disabled(tmp_path):
    import json
    settings = Settings()
    settings.enabled_models_by_profile = {name: [] for name in settings.merged_profiles()}
    path = tmp_path / 'settings.json'
    path.write_text(settings.model_dump_json(), encoding='utf-8')
    catalog = _runtime_picker_options(load_settings(path, apply_model_policy=False))
    assert all(catalog['all_models_by_provider'].values())
    assert json.loads(path.read_text(encoding='utf-8'))['enabled_models_by_profile'] == settings.enabled_models_by_profile
    with pytest.raises(ValueError, match='허용된 모델이 없습니다'):
        load_settings(path)


def test_disabled_default_provider_falls_back_but_explicit_selection_is_rejected(tmp_path):
    settings = Settings()
    name, _ = settings.resolve_profile()
    settings.enabled_models_by_profile = {name: []}
    path = tmp_path / 'settings.json'
    path.write_text(settings.model_dump_json(), encoding='utf-8')
    restored = load_settings(path)
    assert restored.active_profile != name
    assert restored.resolve_profile()[1].allows_model(restored.model)
    with pytest.raises(ValueError, match='허용된 모델이 없습니다'):
        restored.resolve_profile(name)


@pytest.mark.parametrize('profile_name', ['p-gpt', 'codex'])
@pytest.mark.parametrize('enabled', ['gpt-6-sol', 'gpt-6-luna'])
def test_only_gpt6_enabled_restores_stale_gpt56_selection(tmp_path, profile_name, enabled):
    settings = Settings(active_profile=profile_name)
    # Exercise saved pre-GPT-6 catalogs and selections, not only fresh defaults.
    profiles = settings.merged_profiles()
    for profile in profiles.values():
        profile.allowed_models = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']
        profile.last_model = 'gpt-5.6-terra'
    settings.profiles = profiles
    settings.enabled_models_by_profile = {name: [] for name in profiles}
    settings.enabled_models_by_profile[profile_name] = [enabled]
    path = tmp_path / 'settings.json'
    path.write_text(settings.model_dump_json(), encoding='utf-8')

    restored = load_settings(path)
    assert restored.active_profile == profile_name
    assert restored.model == restored.subagent_model == enabled
    restored = restored.merge_cli_overrides(
        active_profile=profile_name, model='gpt-5.6-terra', subagent_model='gpt-5.6-luna',
    )
    assert restored.model == restored.subagent_model == enabled
    options = _runtime_picker_options(restored)
    assert [item['value'] for item in options['models_by_provider'][profile_name]] == [enabled]
    assert all(not models for name, models in options['models_by_provider'].items() if name != profile_name)
    assert 'gpt-5.6-luna' in [item['value'] for item in options['all_models_by_provider'][profile_name]]
