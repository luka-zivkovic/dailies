export {
  configSchema,
  DEFAULT_TIMEOUT_MS,
  inputItemSchema,
  parseConfig,
  type CandidateConfig,
  type Config,
  type InputItem,
  type JudgeConfig,
} from './config.js';
export { judgeItem, judgeResultSchema, type JudgeResult } from './judge.js';
export {
  aggregate,
  decideExitCode,
  decideVerdict,
  EXIT_BLOCK,
  EXIT_PROMOTE,
  EXIT_RUN_ERROR,
  renderMarkdown,
  REPORT_SCHEMA_VERSION,
  reportSchema,
  type ItemResult,
  type Report,
  type Totals,
} from './report.js';
export { runShadow } from './runner.js';
