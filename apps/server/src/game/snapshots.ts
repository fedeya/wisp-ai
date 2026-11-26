// Compare the actual UI payload before adding a revision. Transport bookkeeping
// and invisible model events must not spend a one-use addon channel.
export class SnapshotGate {
  previous = '';
  revision: number;
  constructor(revision = Date.now()) {
    this.revision = revision;
  }
  invalidate() {
    this.previous = '';
  }
  next<T extends object>(snapshot: T): (T & { rev: number }) | null {
    const signature = JSON.stringify(snapshot);
    if (signature === this.previous) {
      return null;
    }
    this.previous = signature;
    return { ...snapshot, rev: ++this.revision };
  }
}
