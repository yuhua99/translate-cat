const encoder = new TextEncoder()

export function sseEvents(events: readonly unknown[]): Response {
  return sseResponse(events.map((event) => `data: ${JSON.stringify(event)}\n\n`))
}

export function sseResponse(chunks: readonly string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
