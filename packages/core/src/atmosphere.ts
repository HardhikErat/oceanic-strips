// ISA atmosphere helpers for Mach <-> TAS. No wind is available on VATSIM, so pilot
// estimates always take precedence over these calculated values.

const TROPOPAUSE_FT = 36089;

export function isaTempK(altFt: number): number {
  return altFt >= TROPOPAUSE_FT ? 216.65 : 288.15 - 0.0019812 * altFt;
}

/** Speed of sound in knots at the given altitude (ISA). */
export function speedOfSoundKt(altFt: number): number {
  return 38.967854 * Math.sqrt(isaTempK(altFt));
}

export function machToTasKt(mach: number, flightLevel: number): number {
  return mach * speedOfSoundKt(flightLevel * 100);
}

export function tasToMach(tasKt: number, flightLevel: number): number {
  return tasKt / speedOfSoundKt(flightLevel * 100);
}
