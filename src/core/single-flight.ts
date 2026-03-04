export function createSingleFlightRunner<TArgs extends unknown[]>(
  run: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<boolean> {
  let inFlight = false

  return async (...args: TArgs): Promise<boolean> => {
    if (inFlight) return false
    inFlight = true
    try {
      await run(...args)
      return true
    } finally {
      inFlight = false
    }
  }
}
