export function applyModelAvailability(runtimeOptions, enabledByProfile = {}) {
  const catalog = runtimeOptions.all_models_by_provider || runtimeOptions.models_by_provider || {};
  const allModels = Object.fromEntries(Object.entries(catalog).map(([profile, models]) => [profile,
    models.map((model) => ({ ...model, enabled: !Object.hasOwn(enabledByProfile, profile) || enabledByProfile[profile].includes(model.value) })),
  ]));
  return {
    ...runtimeOptions,
    all_models_by_provider: allModels,
    models_by_provider: Object.fromEntries(Object.entries(allModels).map(([profile, models]) => [profile, models.filter((model) => model.enabled)])),
  };
}

export function changeModelAvailability(runtimeOptions, saved, { profile, model, enabled } = {}) {
  const catalog = runtimeOptions.all_models_by_provider || {};
  if (typeof profile !== "string" || typeof enabled !== "boolean"
    || !Object.hasOwn(catalog, profile) || (model !== undefined && (typeof model !== "string" || !catalog[profile].some((item) => item.value === model)))) {
    throw new Error("알 수 없는 프로바이더 또는 모델입니다.");
  }
  const next = { ...saved };
  for (const [key, models] of Object.entries(catalog)) {
    if (!Object.hasOwn(next, key)) next[key] = models.map((item) => item.value);
  }
  next[profile] = model === undefined
    ? (enabled ? catalog[profile].map((item) => item.value) : [])
    : enabled ? [...new Set([...next[profile], model])] : next[profile].filter((value) => value !== model);
  return next;
}
