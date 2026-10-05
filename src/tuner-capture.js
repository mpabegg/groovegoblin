// One lease over the input owner's existing InstrumentCapture. Opening a
// tuner neither changes the practice input nor creates a second capture.
export class TunerCaptureLease {
  #generation = 0;
  #owned = false;
  #pending = null;
  constructor(capture, { settings, practiceActive, practicePreparing, preparation }) {
    this.capture = capture;
    this.settings = settings;
    this.practiceActive = practiceActive;
    this.practicePreparing = practicePreparing;
    this.preparation = preparation;
  }
  get owned() { return this.#owned; }
  acquire() {
    if (this.#pending) return this.#pending;
    if (this.capture.active) return Promise.resolve(true);
    const request = ++this.#generation;
    const borrowing = this.practicePreparing();
    this.#owned = !borrowing;
    const operation = borrowing ? this.preparation().then(() => this.capture.active) : this.capture.start(this.settings());
    const pending = Promise.resolve(operation).then(started => request === this.#generation && !!started);
    this.#pending = pending;
    void pending.finally(() => { if (this.#pending === pending) this.#pending = null; });
    return pending;
  }
  release() {
    ++this.#generation;
    const stop = this.#owned && !this.practiceActive();
    this.#owned = false; this.#pending = null;
    if (stop) this.capture.stop(); // Also cancels a permission request's late tracks.
  }
  suspended() { ++this.#generation; this.#owned = false; this.#pending = null; }
}
