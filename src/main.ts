import { loadConfig, loadDotEnv } from './config.js';
import { createApp } from './server.js';

loadDotEnv();
const cfg = loadConfig();
const app = createApp(cfg);
const port = await app.listen();
console.log(
  `llm-agent-evals listening on http://${cfg.host}:${port}  provider=${cfg.provider} model=${cfg.model}` +
    `${cfg.fallbackModel ? ` fallback=${cfg.fallbackModel}` : ''} prompt=${cfg.promptVersion}`,
);
const stop = () => void app.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
