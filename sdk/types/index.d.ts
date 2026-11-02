/**
 * privacy-sentinel SDK 类型声明
 * ---------------------------------------------------------------
 * 手写而非生成：包体只有一个零依赖的 UMD 文件，没必要为它拉一整套 tsc 工具链。
 * 与 src/index.js 保持同步的硬约定：
 *   - 新增导出必须同步改这里，scripts/test-sdk.js 会校验关键声明是否齐全。
 */

/** 命中一条敏感信息。默认不含 raw（需要时显式传 includeRaw） */
export interface SensitiveItem {
  /** 类型 key，如 phone / id / bankcard */
  type: string;
  /** 中文名，如 手机号 */
  label: string;
  /** 风险等级 1-4 */
  level: number;
  /** 等级中文名 */
  levelName: string;
  /** 在原文中的起始下标（含） */
  start: number;
  /** 在原文中的结束下标（不含） */
  end: number;
  /** 脱敏后的值，如 138****8000 */
  masked: string;
  /** 校验位/规则是否通过，false 表示存疑（可能是测试号码） */
  verified: boolean;
  /** 命中原因，便于人工复核 */
  reason?: string;
  /** 来源引擎，本地引擎为 local */
  engine: string;
  /** 原文。仅当 includeRaw: true 时存在 */
  raw?: string;
}

export interface AnalyzeResult {
  items: SensitiveItem[];
  count: number;
  /** 全文最高风险等级，0 表示未命中 */
  level: number;
  levelName: string;
  /** 可直接展示的一句话摘要 */
  summary: string;
  /** 整个调用耗时（毫秒） */
  elapsedMs: number;
}

export interface AnalyzeAndMaskResult extends AnalyzeResult {
  /** 按命中区间重建后的脱敏文本 */
  masked: string;
}

export type MaskStrategy = 'mask' | 'label' | 'remove';

export interface DetectOptions {
  /** 只检测这些类型，传 null/undefined 表示全部 */
  types?: string[];
  /** 低于该等级的命中会被过滤，默认 1 */
  minLevel?: number;
  /** 脱敏策略，默认 mask */
  strategy?: MaskStrategy;
  /** 是否在结果里带上原文，默认 false（安全默认） */
  includeRaw?: boolean;
  /** 是否带上命中原因，默认 true */
  includeReason?: boolean;
}

export interface BatchOk {
  ok: true;
  result: AnalyzeAndMaskResult;
}

export interface BatchFail {
  ok: false;
  error: string;
}

export type BatchResult = BatchOk | BatchFail;

/** 检测：返回命中项数组（按等级从高到低） */
export function detect(text: string, opts?: DetectOptions): SensitiveItem[];

/** 检测 + 摘要 */
export function analyze(text: string, opts?: DetectOptions): AnalyzeResult;

/** 只做脱敏：返回处理后的整段文本 */
export function mask(text: string, opts?: DetectOptions): string;

/** 检测 + 脱敏，一步到位（最常用） */
export function analyzeAndMask(text: string, opts?: DetectOptions): AnalyzeAndMaskResult;

/** 批量检测：等长同序返回，单条失败不中断整批 */
export function detectBatch(list: string[], opts?: DetectOptions): BatchResult[];

/** 单个值脱敏（调用方已知类型时使用） */
export function desensitize(value: string, type: string, strategy?: MaskStrategy): string;

/** 支持的类型枚举：type → 中文名 */
export function types(): Record<string, string>;

/** 等级枚举：level → 中文名 */
export function levels(): Record<number, string>;

export const version: string;
export const strategies: MaskStrategy[];

declare const PrivacySentinel: {
  version: string;
  strategies: MaskStrategy[];
  detect: typeof detect;
  analyze: typeof analyze;
  mask: typeof mask;
  analyzeAndMask: typeof analyzeAndMask;
  detectBatch: typeof detectBatch;
  desensitize: typeof desensitize;
  types: typeof types;
  levels: typeof levels;
  /** 底层引擎，供高级用法（位置映射、抗变形归一化） */
  engine: {
    schema: unknown;
    local: unknown;
    guard: unknown;
  };
};

export default PrivacySentinel;
