'use strict';

/**
 * Re-export the shared cross-cutting type shapes so adopters can name them when
 * annotating their own wiring (tools arrays, providers, ctx, metrics). Declared
 * in `types/index.d.ts`; surfaced here on the root entry so `types` resolves them.
 * @typedef {import('./types').ToolDef} ToolDef
 * @typedef {import('./types').ToolCall} ToolCall
 * @typedef {import('./types').Message} Message
 * @typedef {import('./types').Provider} Provider
 * @typedef {import('./types').GenerateResult} GenerateResult
 * @typedef {import('./types').Usage} Usage
 * @typedef {import('./types').RunMetrics} RunMetrics
 * @typedef {import('./types').Store} Store
 * @typedef {import('./types').Ctx} Ctx
 */

const { Loop } = require('./src/loop');
const { Planner } = require('./src/planner');
const { Evaluator } = require('./src/evaluator');
const { refine } = require('./src/refine');
const { recurse } = require('./src/recurse');
const { buildSearchTool, buildExactTool, buildScanTool, litectxCorpus } = require('./src/recurse-retrieval');
const { remember } = require('./src/remember');
const { judge } = require('./src/judge');
const { calibrate, CALIBRATION_CASES, INJECTION_BATTERY, scoreCase, gradeRun, constantHonored } = require('./src/judge-calibration');
const { assessComplexity, isCritical } = require('./src/complexity');
const { SkillRegistry } = require('./src/skills');
const { createStashSkill } = require('./src/stash');
const { StateMachine } = require('./src/state');
const { Scheduler } = require('./src/scheduler');
const { Checkpoint } = require('./src/checkpoint');
const { Memory } = require('./src/memory');
const { Stream } = require('./src/stream');
const { Retry } = require('./src/retry');
const { runPlan } = require('./src/run-plan');
const { CircuitBreaker } = require('./src/circuit-breaker');
const { wireGate, defaultActionTranslator, judgeToAnnotation } = require('./src/bareguard-adapter');
const { toUnits, fromUnits, unitAssembler, unitTrimmer, harvestKey } = require('./src/context-units');
const {
  BareAgentError,
  ProviderError,
  ToolError,
  TimeoutError,
  ValidationError,
  CircuitOpenError,
  HaltError,
} = require('./src/errors');

module.exports = {
  Loop,
  Planner,
  Evaluator,
  refine,
  recurse,
  buildSearchTool,
  buildExactTool,
  buildScanTool,
  litectxCorpus,
  remember,
  judge,
  calibrate,
  CALIBRATION_CASES,
  INJECTION_BATTERY,
  scoreCase,
  gradeRun,
  constantHonored,
  assessComplexity,
  isCritical,
  SkillRegistry,
  createStashSkill,
  StateMachine,
  Scheduler,
  Checkpoint,
  Memory,
  Stream,
  Retry,
  runPlan,
  CircuitBreaker,
  wireGate,
  defaultActionTranslator,
  judgeToAnnotation,
  toUnits,
  fromUnits,
  unitAssembler,
  unitTrimmer,
  harvestKey,
  BareAgentError,
  ProviderError,
  ToolError,
  TimeoutError,
  ValidationError,
  CircuitOpenError,
  HaltError,
};
