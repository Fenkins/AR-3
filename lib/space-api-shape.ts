export function normalizeCountForClient(count: any): any {
  if (!count || typeof count !== 'object') return count
  return {
    ...count,
    experiments: count.experiments ?? count.Experiment ?? 0,
    breakthroughs: count.breakthroughs ?? count.Breakthrough ?? 0,
    modelCaches: count.modelCaches ?? count.ModelCache ?? 0,
  }
}

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

export function buildCycleSummary(space: any): any {
  const experiments = Array.isArray(space?.experiments)
    ? space.experiments
    : Array.isArray(space?.Experiment)
      ? space.Experiment
      : []
  const variants = Array.isArray(space?.variants)
    ? space.variants
    : Array.isArray(space?.Variant)
      ? space.Variant
      : []

  const completedEvaluationCycles = new Set(
    experiments
      .filter((exp: any) => exp?.status === 'COMPLETED' && exp?.phase === 'EVALUATION')
      .map((exp: any) => exp?.cycleNumber || 1)
  )
  const knownCycles = new Set<number>([
    1,
    ...experiments.map((exp: any) => exp?.cycleNumber || 1),
    ...variants.map((variant: any) => variant?.cycleNumber || 1),
  ])
  const completedCycleCount = completedEvaluationCycles.size
  const activeCycle = Math.max(completedCycleCount + 1, 1)
  knownCycles.add(activeCycle)

  return {
    persistedCurrentCycle: space?.currentCycle || 1,
    activeCycle,
    completedCycleCount,
    completedCycles: Array.from(completedEvaluationCycles).map(Number).sort((a, b) => b - a),
    availableCycles: Array.from(knownCycles).filter(Boolean).sort((a, b) => b - a),
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

  const cycleSummary = buildCycleSummary({ ...space, experiments, variants })

  return {
    ...space,
    _count: normalizeCountForClient(space._count),
    experiments,
    breakthroughs,
    variants: variants.map(normalizeVariantForClient),
    cycleSummary,
    displayCycle: cycleSummary.activeCycle,
    completedCycleCount: cycleSummary.completedCycleCount,
  }
}
