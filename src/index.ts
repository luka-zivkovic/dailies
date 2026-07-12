export {
  configSchema,
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
  decideVerdict,
  renderMarkdown,
  REPORT_SCHEMA_VERSION,
  reportSchema,
  type ItemResult,
  type Report,
  type Totals,
} from './report.js';
export { runShadow } from './runner.js';
