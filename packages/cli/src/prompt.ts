/**
 * The ONE way this CLI asks the user a question.
 *
 * Two independent failures live here, and both were shipped bugs.
 *
 * ## 1. `rl.question()` discards decisions at EOF. Never use it.
 *
 * `readline/promises` settles a pending `question()` only on a `line` event,
 * and it PAUSES the input between questions. When stdin reaches EOF with a
 * question outstanding — the user presses Ctrl-D, or the command is run with
 * piped/redirected input — the interface emits `close`, the promise NEVER
 * SETTLES, commander's action promise hangs, nothing keeps the event loop
 * alive, and node exits **0**.
 *
 * Reproduced against the BUILT binary: `approvals review` with three queued
 * changes and three answers piped in read the first answer, printed the second
 * prompt, and exited 0 with all three rows still `pending`. Every decision the
 * user had already made was discarded and the shell was told the command
 * succeeded. Racing a `close` listener against the question is NOT the fix —
 * it stops the hang but still loses every line sitting in the buffer, because
 * `close` wins before they are delivered.
 *
 * Draining the interface's async iterator keeps it in flowing mode, so every
 * buffered line is delivered and `done` arrives only at real EOF. The prompt is
 * written by hand because that is the one thing `question()` was doing for us.
 *
 * ## 2. Ctrl-C at an interactive prompt must ABORT, not commit.
 *
 * Node's readline closes the interface on `^C` **when nothing is listening for
 * `SIGINT`** (`lib/internal/readline/interface.js`: `if
 * (this.listenerCount('SIGINT') > 0) this.emit('SIGINT'); else this.close()`).
 * A closed interface ends the iterator, which is byte-identical to EOF — so
 * without the listener below, `^C` half-way through `approvals review` looked
 * exactly like Ctrl-D and the answers already given were APPLIED TO GMAIL.
 * Verified on a `terminal: true` interface over a PassThrough (see
 * `prompt.test.ts`): with no listener the second `next()` resolves `done` and
 * nothing distinguishes it from the input simply ending.
 *
 * The two must mean different things, and the asymmetry decides which way:
 *   * **EOF keeps the decisions.** Piped input running out is the normal end of
 *     a scripted review, and Ctrl-D means "end of input", not "cancel". This is
 *     unchanged, and it is what `q` has always meant.
 *   * **SIGINT aborts and commits nothing.** Ctrl-C conventionally means "stop,
 *     do not do it", and it is what a user reaches for the moment they realise
 *     the wrong thing is about to be trashed. Aborting costs a re-run and loses
 *     nothing — every row stays exactly as it was, still queued, still
 *     reviewable. Committing on Ctrl-C costs an unwanted Gmail mutation that no
 *     surface here can undo. When the two errors are that unequal, the safe one
 *     is the default.
 *
 * `aborted` therefore latches on `SIGINT` and every later `ask()` short-circuits
 * to `null`, so a caller that forgets to check it stops asking rather than
 * silently continuing. Callers MUST check it before writing anything.
 *
 * **Scope, stated because it is easy to overclaim:** readline only emits
 * `SIGINT` in TERMINAL mode. With piped or redirected stdin there is no
 * keypress decoding at all, so `^C` arrives as a process signal and node's
 * default handler kills the process — before any commit, which is the same
 * outcome by a different mechanism. This is the interactive-TTY path.
 */

import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

/** The shell's conventional exit code for "terminated by SIGINT" (128 + 2). */
export const SIGINT_EXIT_CODE = 130;

export interface PromptSession {
  /**
   * Writes `prompt` and reads one line.
   *
   * `null` means "no answer": either real EOF, or a `SIGINT` that has already
   * latched `aborted`. The two are distinguished by reading `aborted`, never by
   * the answer.
   */
  ask(prompt: string): Promise<string | null>;
  /** True once the user pressed Ctrl-C at an interactive prompt. */
  readonly aborted: boolean;
}

/**
 * Injectable streams. Defaults are the real stdio; tests pass a PassThrough
 * pair with `terminal: true` so node's own `^C` decoding is what runs, rather
 * than a stand-in for it.
 */
export interface PromptStreams {
  input?: Readable;
  output?: Writable;
  terminal?: boolean;
}

/**
 * Runs `body` with a prompt session, closing the readline interface on every
 * path — including a throw, which used to leave the process holding stdin.
 */
export async function withPrompt<T>(
  body: (session: PromptSession) => Promise<T>,
  streams: PromptStreams = {},
): Promise<T> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const rl = createInterface({
    input,
    output,
    ...(streams.terminal === undefined ? {} : { terminal: streams.terminal }),
  });

  let aborted = false;
  // Registering ANY listener is what stops readline from silently closing on
  // ^C. See the header: a silent close is indistinguishable from EOF.
  rl.on("SIGINT", () => {
    aborted = true;
    rl.close();
  });

  const lines = rl[Symbol.asyncIterator]();
  const session: PromptSession = {
    async ask(prompt: string): Promise<string | null> {
      if (aborted) return null;
      output.write(prompt);
      const next = await lines.next();
      return next.done === true ? null : next.value;
    },
    get aborted(): boolean {
      return aborted;
    },
  };

  try {
    return await body(session);
  } finally {
    rl.close();
  }
}

/**
 * Reuse an existing session, or open one.
 *
 * WHY THIS EXISTS, because it is not decoration. Two sequential readline
 * interfaces over ONE stdin lose input: the first is in flowing mode, so it has
 * already buffered every piped line by the time it is closed, and the second
 * opens on an exhausted stream and sees immediate EOF. `run-action` did exactly
 * that — `printf 'r\ny\nn\n' | email-agent run-action junk` read the `r`, then
 * `reviewOperations` opened a SECOND interface, saw EOF on its first ask, and
 * both review answers were silently discarded with the rows left pending.
 * Porting the prompt off `rl.question()` did not fix that; only threading one
 * session through both does.
 */
export async function usingPrompt<T>(
  session: PromptSession | undefined,
  body: (session: PromptSession) => Promise<T>,
  streams?: PromptStreams,
): Promise<T> {
  if (session) return body(session);
  return withPrompt(body, streams);
}

export interface SingleAnswer {
  /** `null` at EOF or after an abort. */
  answer: string | null;
  aborted: boolean;
}

/** One question, one answer. Same rules as `withPrompt`. */
export async function askOnce(
  prompt: string,
  streams: PromptStreams = {},
): Promise<SingleAnswer> {
  return withPrompt(async (session) => {
    const answer = await session.ask(prompt);
    return { answer, aborted: session.aborted };
  }, streams);
}
