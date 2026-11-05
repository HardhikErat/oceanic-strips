// Server clock. Real UTC for live operation; a scenario can start at another time and run faster.
export class Clock {
  private startReal = Date.now();
  constructor(private startSim = Date.now(), private scale = 1) {}
  now(): number {
    return this.startSim + (Date.now() - this.startReal) * this.scale;
  }
  setScale(scale: number) {
    this.startSim = this.now();
    this.startReal = Date.now();
    this.scale = scale;
  }
  reset(startSim: number, scale = 1) {
    this.startSim = startSim;
    this.startReal = Date.now();
    this.scale = scale;
  }
  get rate() {
    return this.scale;
  }
  info() {
    return { simNow: this.now(), realNow: Date.now(), scale: this.scale };
  }
}
