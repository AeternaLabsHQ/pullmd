/**
 * Copy usage/audio/image fields from an LLM adapter result into metadata.
 * Shared by the web extraction path and the Reddit embedded-image path.
 *
 * @param {object} metadata  extraction metadata, mutated in place
 * @param {object} media     adapter result ({usage, audioSeconds, imageSize, pdfPages})
 */
export function applyMediaUsage(metadata, media) {
  if (media.usage) {
    metadata.llmModel = media.usage.model || null;
    if (media.usage.total_tokens !== undefined) metadata.llmTokens = media.usage.total_tokens;
    if (media.usage.prompt_tokens !== undefined) metadata.llmPromptTokens = media.usage.prompt_tokens;
    if (media.usage.completion_tokens !== undefined) metadata.llmCompletionTokens = media.usage.completion_tokens;
  }
  if (media.audioSeconds != null) metadata.audioSeconds = media.audioSeconds;
  if (media.imageSize) metadata.imageSize = media.imageSize;
  if (media.pdfPages != null) metadata.pdfPages = media.pdfPages;
}
