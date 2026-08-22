/**
 * One side of the two-PROCESS session-store race driven by
 * `config/session-cross-process.race.test.ts`.
 *
 * A real forked OS process with its own module instances, its own
 * `SESSION_PATH` resolved from the `$HOME` it inherits, and no shared memory
 * with its opponent — the scenario an in-process test cannot reach. `email-agent
 * serve` alongside `npm run dev`, or two `serve`s on two ports, is exactly this.
 *
 * PROTOCOL — a two-phase barrier plus a wall-clock start, because timing alone
 * is not evidence:
 *
 *   parent -> "prepare" : load the module and reply "ready". Both sides pay the
 *                         module-load cost BEFORE either is told to act, so the
 *                         race is over the store and not over `import()`.
 *   parent -> "go"      : busy-spin until the shared `startAt` timestamp and
 *                         then perform ONE store operation, reporting what
 *                         happened.
 *
 * The spin is deliberate rather than a `setTimeout`: it aligns the two
 * processes to well under a millisecond, which is the scale of the
 * read-modify-write being contested. A timer's clamping would put them
 * milliseconds apart and the race would simply not happen.
 *
 * Three modes, because the one defect has three costumes:
 *   "exchange" — redeem the unlock token the parent minted. Exactly one process
 *                may succeed; the loser must observe the burn (`used`).
 *   "failure"  — present a WRONG token, which must be recorded against the
 *                rate-limit window. Two processes doing this must add two
 *                entries, not one.
 *   "renew"    — present a live session cookie at a future clock, forcing the
 *                idle renewal to write. Racing this against an "exchange" is
 *                what catches a renewal that writes back a store it read
 *                BEFORE the other process burned the token.
 */

import { SESSION_PATH } from "../config/defaults.js";
import {
  SESSION_TTL_MS,
  exchangeUnlockToken,
  hasValidSession,
  type UnlockExchangeResult,
} from "../config/session.js";

export type SessionWorkerMode = "exchange" | "failure" | "renew";

export interface PrepareMessage {
  type: "prepare";
  round: number;
}
export interface GoMessage {
  type: "go";
  round: number;
  /** The plaintext value to present: an unlock token, or a session cookie. */
  value: string;
  /** Epoch ms both processes spin until before acting. */
  startAt: number;
}
export type ParentMessage = PrepareMessage | GoMessage;

export interface ReadyMessage {
  type: "ready";
  round: number;
}
export interface DoneMessage {
  type: "done";
  round: number;
  /** The exchange's own answer, verbatim. Absent in "renew" mode. */
  result?: UnlockExchangeResult;
  /** What `hasValidSession` answered. Present only in "renew" mode. */
  valid?: boolean;
  /** Wall clock at the instant the call was issued, for the race report. */
  startedAt: number;
}
export type SessionWorkerMessage = ReadyMessage | DoneMessage;

const mode = (process.argv[2] ?? "exchange") as SessionWorkerMode;
const label = process.argv[3] ?? "?";

function send(message: SessionWorkerMessage): void {
  process.send?.(message);
}

process.on("message", (raw: unknown) => {
  const message = raw as ParentMessage;
  if (message.type === "prepare") {
    // Touching SESSION_PATH here is what forces `config/defaults.ts` to resolve
    // against the inherited $HOME before the timed section, so the first store
    // read in "go" is not also a module load.
    const home = process.env["HOME"] ?? "";
    if (!home || !SESSION_PATH.startsWith(home)) {
      throw new Error(
        `${label}: SESSION_PATH is ${SESSION_PATH}, which is not inside the inherited ` +
          `HOME (${home}). This worker would be racing over the developer's real store.`,
      );
    }
    send({ type: "ready", round: message.round });
    return;
  }

  while (Date.now() < message.startAt) {
    // Busy-wait. See the header: sub-millisecond alignment is the point.
  }
  const startedAt = Date.now();
  if (mode === "renew") {
    // A clock past the half-TTL mark is what makes renewal actually WRITE
    // rather than return early — the same thing a browser used the next day
    // does, without the test waiting thirteen hours for it.
    const valid = hasValidSession(message.value, startedAt + SESSION_TTL_MS * 0.6);
    send({ type: "done", round: message.round, valid, startedAt });
    return;
  }
  const result = exchangeUnlockToken(message.value);
  send({ type: "done", round: message.round, result, startedAt });
});
