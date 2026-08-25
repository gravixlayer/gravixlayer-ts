/**
 * Server-sent events parsing.
 *
 * The streaming endpoints (command output, code output, file watch, PTY
 * attach) all speak `text/event-stream`. This implements the WHATWG event
 * stream parsing rules: CR, LF, and CRLF line breaks, a leading BOM, comment
 * lines, an optional space after the field colon, and `data` fields that span
 * multiple lines and are joined with `\n`.
 */

/**
 * Locate the next CR, LF, or CRLF starting at `from`.
 *
 * A CR at the very end is `pending` unless `flush` is set: it may be the first
 * half of a CRLF that arrives in the next chunk.
 */
function nextLineBreak(
  buffer: string,
  from: number,
  flush = false,
): { index: number; length: number; pending?: boolean } | null {
  const cr = buffer.indexOf('\r', from);
  const lf = buffer.indexOf('\n', from);
  if (cr === -1 && lf === -1) return null;

  if (lf !== -1 && (cr === -1 || lf < cr)) {
    return { index: lf, length: 1 };
  }

  // CR, possibly followed by LF.
  if (!flush && cr + 1 === buffer.length) return { index: cr, length: 1, pending: true };
  if (cr + 1 < buffer.length && buffer.charCodeAt(cr + 1) === 10) {
    return { index: cr, length: 2 };
  }
  return { index: cr, length: 1 };
}

/** One dispatched server-sent event. */
export interface SSEEvent {
  /** The `event:` field, or `'message'` when the stream did not set one. */
  event: string;
  /** The accumulated `data:` payload with the trailing newline removed. */
  data: string;
  /** The `id:` field, when present. */
  id?: string;
  /**
   * The stream's reconnection hint in milliseconds, from the most recent
   * `retry:` field. A stream-level setting, so it persists across events once
   * the server has sent one.
   */
  retry?: number;
}

/**
 * Decode a byte stream into server-sent events.
 *
 * The stream is always released, including when the consumer breaks out of the
 * loop early or throws, so an abandoned stream never leaks a socket.
 */
export async function* iterSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');

  let buffer = '';
  let atStreamStart = true;

  // Fields accumulated for the event currently being parsed.
  let eventType = '';
  let data: string[] = [];
  let lastId: string | undefined;
  let retry: number | undefined;

  const takeEvent = (): SSEEvent | null => {
    // A block with no data field is a no-op per the spec (it only updates the
    // reconnection id), so nothing is dispatched.
    if (data.length === 0) {
      eventType = '';
      return null;
    }
    const event: SSEEvent = {
      event: eventType || 'message',
      data: data.join('\n'),
    };
    if (lastId !== undefined) event.id = lastId;
    if (retry !== undefined) event.retry = retry;

    eventType = '';
    data = [];
    return event;
  };

  const handleLine = (line: string): SSEEvent | null => {
    if (line === '') return takeEvent();
    if (line.startsWith(':')) return null; // Comment, often a keep-alive.

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        eventType = value;
        break;
      case 'data':
        data.push(value);
        break;
      case 'id':
        // The spec requires ignoring an id containing a NULL character.
        if (!value.includes('\0')) lastId = value;
        break;
      case 'retry': {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 0) retry = parsed;
        break;
      }
      default:
        break; // Unknown fields are ignored.
    }
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      let chunk = decoder.decode(value, { stream: true });
      if (atStreamStart) {
        if (chunk.startsWith('\uFEFF')) chunk = chunk.slice(1);
        atStreamStart = false;
      }
      buffer += chunk;

      let start = 0;
      while (start < buffer.length) {
        const lineBreak = nextLineBreak(buffer, start);
        if (lineBreak === null) break;
        // A trailing CR may be the first half of a CRLF that lands next.
        if (lineBreak.pending) break;

        const event = handleLine(buffer.slice(start, lineBreak.index));
        start = lineBreak.index + lineBreak.length;
        if (event) yield event;
      }
      if (start > 0) buffer = buffer.slice(start);
    }

    // Flush whatever the decoder was holding, then the final partial line.
    buffer += decoder.decode();
    if (buffer !== '') {
      let start = 0;
      while (start < buffer.length) {
        const lineBreak = nextLineBreak(buffer, start, true);
        if (lineBreak === null) {
          const event = handleLine(buffer.slice(start));
          if (event) yield event;
          break;
        }
        const event = handleLine(buffer.slice(start, lineBreak.index));
        start = lineBreak.index + lineBreak.length;
        if (event) yield event;
      }
    }
    const trailing = takeEvent();
    if (trailing) yield trailing;
  } finally {
    // `cancel` signals the producer to stop but leaves the reader attached, so
    // the lock has to be dropped separately for the stream to be reusable.
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // Already released, which is the outcome we wanted.
    }
  }
}

/**
 * Decode a byte stream into the JSON payloads carried by its events.
 *
 * Events whose data is `[DONE]` terminate the stream, matching the sentinel
 * used by the agent invocation endpoints. Payloads that are not valid JSON are
 * yielded as `{ raw: <text> }` rather than throwing, so one malformed frame
 * cannot abort an otherwise healthy stream.
 */
export async function* iterSSEJson<T = unknown>(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<T, void, undefined> {
  for await (const event of iterSSE(stream)) {
    const data = event.data;
    if (data === '' || data === '[DONE]') {
      if (data === '[DONE]') return;
      continue;
    }
    try {
      yield JSON.parse(data) as T;
    } catch {
      yield { raw: data } as T;
    }
  }
}
