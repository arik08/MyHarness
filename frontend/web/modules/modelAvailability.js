export function reconcileSessionModel(options, catalog) {
  const available = catalog.models_by_provider || {};
  const requested = String(options.activeProfile || options.active_profile || "").trim();
  const profile = available[requested]?.length ? requested
    : Object.keys(available).find((key) => available[key].length && catalog.providers?.some((item) => item.value === key && item.active))
      || Object.keys(available).find((key) => available[key].length);
  if (!profile) {
    throw Object.assign(new Error("사용 가능한 모델이 없습니다. 모델 설정에서 사용할 모델을 활성화해 주세요."), { status: 409 });
  }
  const models = available[profile];
  const model = models.find((item) => item.value === options.model)
    || models.find((item) => item.active) || models[0];
  return { ...options, activeProfile: profile, model: model.value };
}

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
