export function resolveStrictCodeGatesForSpaceCreate(body: { useGpu?: boolean; strictCodeGates?: boolean | null | undefined }): boolean {
  if (typeof body.strictCodeGates === 'boolean') {
    return body.strictCodeGates
  }

  return body.useGpu === true
}
