/** Tracks only explicit user requests to reveal a search result. */
export class FindScrollIntent {
  private requested = 0;
  private completed = 0;

  request(): number {
    return ++this.requested;
  }

  /** Wait for the current result snapshot before resolving an intent. */
  pending(ready: boolean): number | null {
    return ready && this.requested !== this.completed ? this.requested : null;
  }

  /** A cancelled frame must not consume a newer navigation request. */
  complete(ticket: number): boolean {
    if (ticket !== this.requested) return false;
    this.completed = ticket;
    return true;
  }
}
