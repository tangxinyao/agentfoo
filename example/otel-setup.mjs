/**
 * Consumer-side OTLP wiring for the example suite — **not** part of the agentfoo
 * package. agentfoo requires the zero-dependency `@opentelemetry/api` as a peer
 * and emits spans through it; whatever turns those spans into OTLP traffic is the
 * consumer's choice. This file is ours.
 *
 * Usage (the CLI appends its own `--import` to NODE_OPTIONS, so the SDK lands in
 * the vitest workers too, which is where the reporter hands spans over):
 *
 *   # no collector needed — print the spans agentfoo produces
 *   AGENTFOO_OTEL_CONSOLE=1 NODE_OPTIONS="--import $PWD/otel-setup.mjs" \
 *     node --import ../scripts/register-ts.mjs ../src/cli.ts run -a hermes forced-skill
 *
 *   # or ship them to any OTLP/HTTP collector (Tempo, Jaeger, Phoenix, Grafana…)
 *   AGENTFOO_OTEL_ENDPOINT=http://127.0.0.1:4318/v1/traces \
 *     NODE_OPTIONS="--import $PWD/otel-setup.mjs" …
 *
 * With neither variable set this is a no-op, so it is safe to leave wired up.
 */
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import * as resources from '@opentelemetry/resources'

const endpoint = process.env.AGENTFOO_OTEL_ENDPOINT
const toConsole = process.env.AGENTFOO_OTEL_CONSOLE === '1'

// Without a service name the collector reports every span as
// `unknown_service:node`, which makes a dashboard's first filter useless.
// `OTEL_SERVICE_NAME` overrides it, like any other instrumented process.
const resource = resources.resourceFromAttributes({
  'service.name': process.env.OTEL_SERVICE_NAME ?? 'agentfoo',
})

if (endpoint || toConsole) {
  const exporter = toConsole ? new ConsoleSpanExporter() : new OTLPTraceExporter({ url: endpoint })
  // Batching needs a flush to be deterministic; `agentfoo otel` awaits it via the
  // global below, and SimpleSpanProcessor (the default) exports on `span.end()`
  // so a short-lived process cannot lose spans.
  const processor =
    process.env.AGENTFOO_OTEL_BATCH === '1'
      ? new BatchSpanProcessor(exporter)
      : new SimpleSpanProcessor(exporter)
  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [processor],
  })
  provider.register()

  // Convention `agentfoo otel` uses to flush deterministically: the api has no
  // forceFlush (that is the SDK's job), so we publish the provider instead.
  globalThis.__AGENTFOO_OTEL_PROVIDER__ = provider

  // agentfoo exports in the reporter, at the very end of a run. Give the
  // export a chance to reach the wire before the process goes away.
  const flush = () => {
    provider.forceFlush().catch(() => {})
  }
  process.on('beforeExit', flush)
  process.on('SIGINT', () => {
    flush()
    process.exit(130)
  })
}
