// OpenTelemetry setup for the sample API. Loaded with `node --require`.
//
// A real project keeps its own exporter and adds Parallax as a second one
// ("dual export"). The only Parallax-specific parts are the endpoint and the
// Authorization header.
const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
const { Resource } = require("@opentelemetry/resources");

const parallax = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  headers: { authorization: `Bearer ${process.env.PARALLAX_API_KEY}` },
});

const provider = new NodeTracerProvider({
  resource: new Resource({ "service.name": process.env.OTEL_SERVICE_NAME || "sample-api" }),
  spanProcessors: [
    // new BatchSpanProcessor(yourOwnApmExporter),   <- the project's own monitoring, unchanged
    new BatchSpanProcessor(parallax, { scheduledDelayMillis: 2000 }),
  ],
});
provider.register();

registerInstrumentations({ instrumentations: [new HttpInstrumentation()] });
