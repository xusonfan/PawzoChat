/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

export function availableStickerProviders(rawProviders) {
  return (rawProviders || [])
    .map(provider => ({
      ...provider,
      models: (provider.models || []).filter(model => model.id),
    }))
    .filter(provider => provider.api_key_set && provider.models.length > 0);
}

export function selectedStickerModel(providers, providerName, modelId) {
  const models = (providers || []).find(provider => provider.name === providerName)?.models || [];
  return models.find(model => model.id === modelId) || null;
}

export function modelSupportsReferenceImages(providers, providerName, modelId) {
  return !!selectedStickerModel(providers, providerName, modelId)?.supports_reference_images;
}