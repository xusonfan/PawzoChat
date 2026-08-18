export function chooseImageModel(providers, preferredProvider, preferredModel) {
  const available = (providers || []).filter(provider => (
    provider?.api_key_set && Array.isArray(provider.models) && provider.models.length > 0
  ));
  const provider = available.find(item => item.name === preferredProvider) || available[0] || null;
  const model = provider?.models.find(item => item.id === preferredModel)
    || provider?.models[0]
    || null;
  return {
    providers: available,
    provider: provider?.name || "",
    model: model?.id || "",
  };
}

export function toggleImageSelection(selectedIds, imageId) {
  const next = new Set(selectedIds || []);
  if (next.has(imageId)) next.delete(imageId);
  else next.add(imageId);
  return next;
}

export function allImageIds(images) {
  return (images || [])
    .map(image => image?.id)
    .filter(imageId => typeof imageId === "string" && imageId);
}