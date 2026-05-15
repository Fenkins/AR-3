export function normalizeVariantForClient(variant: any): any {
  if (!variant || typeof variant !== 'object') return variant

  const rawSteps = Array.isArray(variant.steps)
    ? variant.steps
    : Array.isArray(variant.VariantStep)
      ? variant.VariantStep
      : []

  return {
    ...variant,
    steps: rawSteps.map((step: any) => ({ ...step })),
  }
}

export function normalizeSpaceForClient(space: any): any {
  if (!space || typeof space !== 'object') return space

  const experiments = Array.isArray(space.experiments)
    ? space.experiments
    : Array.isArray(space.Experiment)
      ? space.Experiment
      : []
  const breakthroughs = Array.isArray(space.breakthroughs)
    ? space.breakthroughs
    : Array.isArray(space.Breakthrough)
      ? space.Breakthrough
      : []
  const variants = Array.isArray(space.variants)
    ? space.variants
    : Array.isArray(space.Variant)
      ? space.Variant
      : []

  return {
    ...space,
    experiments,
    breakthroughs,
    variants: variants.map(normalizeVariantForClient),
  }
}
