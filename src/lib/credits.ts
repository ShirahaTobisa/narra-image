import type { GenerationType, ProviderMode } from "@/lib/types";

type CreditInput = {
  providerMode: ProviderMode;
  builtInCreditCost: number;
  count: number;
};

type CreditGuardInput = CreditInput & {
  credits: number;
};

export function shouldChargeCredits(providerMode: ProviderMode) {
  return providerMode === "built_in";
}

export function resolveGenerationCount({ generationType, count }: { generationType: GenerationType; count: number }) {
  return generationType === "text_to_image" ? count : 1;
}

export function calculateGenerationCost({
  providerMode,
  builtInCreditCost,
  count,
}: CreditInput) {
  return shouldChargeCredits(providerMode) ? builtInCreditCost * count : 0;
}

export function hasEnoughCredits({
  providerMode,
  credits,
  builtInCreditCost,
  count,
}: CreditGuardInput) {
  return credits >= calculateGenerationCost({ providerMode, builtInCreditCost, count });
}

type ResolveCreditCostInput = {
  generationType: GenerationType;
  imageCreditCost: number;
  videoCreditCost: number;
};

export function isVideoGenerationType(generationType: GenerationType) {
  return generationType === "text_to_video" || generationType === "image_to_video";
}

export function resolveCreditCost({
  generationType,
  imageCreditCost,
  videoCreditCost,
}: ResolveCreditCostInput) {
  return isVideoGenerationType(generationType) ? videoCreditCost : imageCreditCost;
}
