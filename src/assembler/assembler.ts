import * as path from 'path';
import {
  AssembleResult,
  ExpressionEvalContext,
  IfFrame,
  LocalLabelScopeIndex,
  PrintMessage,
  SourceOrigin } from './types';
import {
  stripInlineComment,
  parseNumberFull,
  parseAddressToken,
  regCodes,
  describeOrigin
} from './utils';

import { evaluateConditionExpression } from './expression';
import { prepareMacros, expandMacroInvocations } from './macro';
import { expandLoopDirectives } from './loops';
import { processIncludes } from './includes';
import { registerLabel as registerLabelHelper, getScopeKey } from './labels';
import { tokenizeLineWithOffsets, argsAfterToken, isAddressDirective, checkLabelOnDirective } from './common';
import { handleDB, handleDW, handleDS, DataContext } from './data';
import {
  handleIfDirective,
  handleEndifDirective,
  handlePrintDirective,
  handleErrorDirective,
  handleEncodingDirective,
  handleTextDirective,
  DirectiveContext
} from './directives';
import {
  resolveAddressToken as resolveAddressTokenInstr,
  encodeMVI,
  encodeMOV,
  encodeLXI,
  encodeThreeByteAddress,
  encodeImmediateOp,
  encodeRegisterOp,
  InstructionContext
} from './instructions';
import { AssemblyEvalState, evaluateExpressionValue, processVariableAssignment } from './pass_helpers';
import { createAssembleAndWrite } from './assemble_write';

export function assemble(
  source: string,
  sourcePath?: string)
  : AssembleResult
{
  let expanded: { lines: string[]; origins: SourceOrigin[] };

  try {
    expanded = processIncludes(source, sourcePath, sourcePath, 0);
  } catch (err: any) {
    return { success: false, errors: [err.message] };
  }
  const macroPrep = prepareMacros(expanded.lines, expanded.origins, sourcePath);
  if (macroPrep.errors.length) {
    return { success: false, errors: macroPrep.errors, origins: expanded.origins };
  }
  const macroExpanded = expandMacroInvocations(macroPrep.lines, macroPrep.origins, macroPrep.macros, sourcePath);
  if (macroExpanded.errors.length) {
    return { success: false, errors: macroExpanded.errors, origins: macroExpanded.origins };
  }

  const loopExpanded = expandLoopDirectives(macroExpanded.lines, macroExpanded.origins, sourcePath);
  if (loopExpanded.errors.length) {
    return { success: false, errors: loopExpanded.errors, origins: loopExpanded.origins };
  }

  const lines = loopExpanded.lines;
  const labels = new Map<string, { addr: number; line: number; src?: string }>();
  const consts = new Map<string, number>();
  // Track which identifiers are variables (can be reassigned)
  const variables = new Set<string>();
  // localsIndex: scopeKey -> (localName -> array of { key, line }) ordered by appearance
  const localsIndex: LocalLabelScopeIndex = new Map();
  // global numeric id counters per local name to ensure exported keys are unique
  const globalLocalCounters = new Map<string, number>();
  const scopes: string[] = new Array(lines.length);
  const alignDirectives: Array<{ value: number }> = new Array(lines.length);
  let directiveCounter = 0;

  // Initialize the current address counter to 0
  let addr = 0;
  const errors: string[] = [];
  const warnings: string[] = [];
  const printMessages: PrintMessage[] = [];
  const origins = loopExpanded.origins;

  const ifStack: IfFrame[] = [];

  // Directive and data helpers share these contexts to mutate shared state
  const directiveCtx: DirectiveContext = {
    labels,
    consts,
    variables,
    errors,
    warnings,
    printMessages,
    textEncoding: 'ascii',
    textCase: 'mixed',
    localsIndex,
    scopes
  };
  const dataCtx: DataContext = {
    labels,
    consts,
    localsIndex,
    scopes,
    errors
  };

  const evalState: AssemblyEvalState = { labels, consts, localsIndex, scopes };

  // Helper to register a label using the imported function
  function registerLabel(
    name: string, address: number, origin: SourceOrigin | undefined,
    fallbackLine: number, scopeKey: string)
  {
    registerLabelHelper(name, address, origin, fallbackLine, scopeKey,
                        labels, localsIndex, globalLocalCounters, errors,
                        sourcePath);
  }

  // Helper to tokenize with offsets - using imported function
  const tokenize = tokenizeLineWithOffsets;

  // Helper to create scope key
  function makeScopeKey(orig?: SourceOrigin): string {
    return getScopeKey(orig, sourcePath, directiveCounter);
  }


  //////////////////////////////////////////////////////////////////////////////
  //
  // First pass: labels and address calculation
  //
  //////////////////////////////////////////////////////////////////////////////

  for (let i = 0; i < lines.length; i++)
  {
    const raw = lines[i];
    const line = stripInlineComment(raw).trim();
    if (!line) continue;

    if (i > 0) {
      const prev = origins[i - 1];
      const curr = origins[i];
      const prevKey = prev && prev.file ? path.resolve(prev.file) : (sourcePath ? path.resolve(sourcePath) : '<memory>');
      const currKey = curr && curr.file ? path.resolve(curr.file) : (sourcePath ? path.resolve(sourcePath) : '<memory>');
      if (prevKey !== currKey) {
        directiveCounter++;
      }
    }
    scopes[i] = makeScopeKey(origins[i]);
    const originDesc = describeOrigin(origins[i], i + 1, sourcePath);

    // Check for labels on directives that don't allow them
    if (checkLabelOnDirective(line, 'if')) {
      errors.push(`Labels are not allowed on .if directives at ${originDesc}`);
      continue;
    }
    if (checkLabelOnDirective(line, 'endif')) {
      errors.push(`Labels are not allowed on .endif directives at ${originDesc}`);
      continue;
    }
    if (checkLabelOnDirective(line, 'print')) {
      errors.push(`Labels are not allowed on .print directives at ${originDesc}`);
      continue;
    }
    if (checkLabelOnDirective(line, 'error')) {
      errors.push(`Labels are not allowed on .error directives at ${originDesc}`);
      continue;
    }
    const labelVarMatch = line.match(/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:\s*[A-Za-z_][A-Za-z0-9_]*\s+\.var\b/i);
    if (labelVarMatch) {
      errors.push(`Labels are not allowed on .var directives at ${originDesc}`);
      continue;
    }

    // Handle .endif directive
    if (handleEndifDirective(line, origins[i], i + 1, sourcePath, ifStack, directiveCtx)) {
      continue;
    }

    // Handle .if directive
    if (handleIfDirective(line, origins[i], i + 1, sourcePath, ifStack, directiveCtx)) {
      continue;
    }

    const blockActive = ifStack.length === 0 ? true : ifStack[ifStack.length - 1].effective;
    if (!blockActive) continue;

    // Skip .print and .error directives in first pass
    if (/^\.print\b/i.test(line)) {
      continue;
    }
    if (/^\.error\b/i.test(line)) {
      continue;
    }

    // .var directive: "NAME .var InitialValue"
    const varMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+\.var\b(.*)$/i);
    if (varMatch) {
      const name = varMatch[1];
      const rhs = (varMatch[2] || '').trim();
      if (!rhs.length) {
        errors.push(`Missing initial value for .var ${name} at ${i + 1}`);
        continue;
      }
      let val: number | null = parseNumberFull(rhs);
      if (val === null) {
        if (consts.has(rhs)) val = consts.get(rhs)!;
        else if (labels.has(rhs)) val = labels.get(rhs)!.addr;
      }
      // If still null, try evaluating as expression
      if (val === null) {
        const result = evaluateExpressionValue(rhs, i + 1, `Bad initial value '${rhs}' for .var ${name}`, evalState);
        val = result.value;
        if (result.error) {
          errors.push(result.error);
          val = null;
        }
      }
      if (val === null) {
        errors.push(`Bad initial value '${rhs}' for .var ${name} at ${i + 1}`);
      } else {
        consts.set(name, val);
        variables.add(name); // Mark this identifier as a variable
      }
      continue;
    }

    const tokenized = tokenize(line);
    const tokens = tokenized.tokens;
    const tokenOffsets = tokenized.offsets;
    if (!tokens.length) continue;
    let pendingDirectiveLabel: string | null = null;

    // simple constant / EQU handling: "NAME = expr" or "NAME EQU expr"
    if (tokens.length >= 3 && (tokens[1] === '=' || tokens[1].toUpperCase() === 'EQU')) {
      const name = tokens[0];
      // Skip variable assignments in first pass (they'll be processed in second pass)
      if (variables.has(name)) {
        continue;
      }
      const rhs = tokens.slice(2).join(' ').trim();
      let val: number | null = parseNumberFull(rhs);
      if (val === null) {
        if (consts.has(rhs)) val = consts.get(rhs)!;
        else if (labels.has(rhs)) val = labels.get(rhs)!.addr;
      }
      // If still null, try evaluating as expression
      if (val === null) {
        const result = evaluateExpressionValue(rhs, i + 1, `Bad constant value '${rhs}' for ${name}`, evalState);
        val = result.value;
        if (result.error) {
          errors.push(result.error);
          val = null;
        }
      }
      if (val === null) {
        errors.push(`Bad constant value '${rhs}' for ${name} at ${i + 1}`);
      } else {
        // Check if this is a reassignment attempt
        if (consts.has(name) && !variables.has(name)) {
          errors.push(`Cannot reassign constant '${name}' at ${i + 1} (use .var to create a variable instead)`);
        } else {
          consts.set(name, val);
        }
      }
      continue;
    }
    const assignMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (assignMatch) {
      const name = assignMatch[1];
      // Skip variable assignments in first pass
      if (variables.has(name)) {
        continue;
      }
      const rhs = assignMatch[2].trim();
      let val: number | null = parseNumberFull(rhs);
      if (val === null) {
        if (consts.has(rhs)) val = consts.get(rhs)!;
        else if (labels.has(rhs)) val = labels.get(rhs)!.addr;
      }
      // If still null, try evaluating as expression
      if (val === null) {
        const result = evaluateExpressionValue(rhs, i + 1, `Bad constant value '${rhs}' for ${name}`, evalState);
        val = result.value;
        if (result.error) {
          errors.push(result.error);
          val = null;
        }
      }
      if (val === null) errors.push(`Bad constant value '${rhs}' for ${name} at ${i + 1}`);
      else {
        // Check if this is a reassignment attempt
        if (consts.has(name) && !variables.has(name)) {
          errors.push(`Cannot reassign constant '${name}' at ${i + 1} (use .var to create a variable instead)`);
        } else {
          consts.set(name, val);
        }
      }
      continue;
    }
    const equMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+EQU\s+(.+)$/i);
    if (equMatch) {
      const name = equMatch[1];
      // Skip variable assignments in first pass
      if (variables.has(name)) {
        continue;
      }
      const rhs = equMatch[2].trim();
      let val: number | null = parseNumberFull(rhs);
      if (val === null) {
        if (consts.has(rhs)) val = consts.get(rhs)!;
        else if (labels.has(rhs)) val = labels.get(rhs)!.addr;
      }
      // If still null, try evaluating as expression
      if (val === null) {
        const result = evaluateExpressionValue(rhs, i + 1, `Bad constant value '${rhs}' for ${name}`, evalState);
        val = result.value;
        if (result.error) {
          errors.push(result.error);
          val = null;
        }
      }
      if (val === null) errors.push(`Bad constant value '${rhs}' for ${name} at ${i + 1}`);
      else {
        // Check if this is a reassignment attempt
        if (consts.has(name) && !variables.has(name)) {
          errors.push(`Cannot reassign constant '${name}' at ${i + 1} (use .var to create a variable instead)`);
        } else {
          consts.set(name, val);
        }
      }
      continue;
    }


    if (tokens[0].endsWith(':')) {
      const candidate = tokens[0].slice(0, -1);
      tokens.shift();
      tokenOffsets.shift();
      const nextToken = tokens.length ? tokens[0] : '';
      if (isAddressDirective(nextToken)) {
        pendingDirectiveLabel = candidate;
      } else {
        registerLabel(candidate, addr, origins[i], i + 1, scopes[i]);
      }
      if (!tokens.length) {
        continue;
      }
    } else if (tokens.length >= 2 && isAddressDirective(tokens[1])) {
      pendingDirectiveLabel = tokens[0];
      tokens.shift();
      tokenOffsets.shift();
    }

    const op = tokens[0].toUpperCase();

    if (op === 'DB' || op === '.BYTE') {
      addr += handleDB(line, tokens, tokenOffsets, i + 1, origins[i], sourcePath, dataCtx);
      continue;
    }

    if (op === 'DW' || op === '.WORD') {
      addr += handleDW(line, tokens, tokenOffsets, i + 1, origins[i], sourcePath, dataCtx);
      continue;
    }

    if (op === 'DS') {
      addr += handleDS(line, tokens, tokenOffsets, i + 1, dataCtx);
      continue;
    }

    if (op === '.ENCODING'){
      handleEncodingDirective(line, origins[i], i + 1, sourcePath, directiveCtx, tokenOffsets, tokens)
      continue;
    }

    if (op === '.TEXT') {
      addr += handleTextDirective(line, origins[i], i + 1, sourcePath, directiveCtx, tokenOffsets, tokens);
      continue;
    }

    if (op === '.ORG' || op === 'ORG') {
      // .org addr
      const rest = argsAfterToken(line, tokens[0], tokenOffsets[0]);
      const aTok = rest.trim().split(/\s+/)[0];
      const org = origins[i];
      let val: number | null = null;
      const num = parseNumberFull(aTok);
      if (num !== null) val = num & 0xffff;
      else if (aTok && aTok[0] === '@') {
        // try to resolve local label in current scope
        const scopeKey = makeScopeKey(org);
        const fileMap = localsIndex.get(scopeKey);
        if (fileMap) {
          const arr = fileMap.get(aTok.slice(1));
          if (arr && arr.length) {
            // pick first definition (definitions earlier in file would be recorded)
            const key = arr[0].key;
            val = labels.get(key)!.addr & 0xffff;
          }
        }
      } else if (labels.has(aTok)) {
        val = labels.get(aTok)!.addr & 0xffff;
      }
      if (val === null) { errors.push(`Bad ORG address '${aTok}' at ${i + 1}`); continue; }
      addr = val;
      // .org defines a new (narrower) scope region for subsequent labels
      directiveCounter++;
      if (pendingDirectiveLabel) {
        const org = origins[i];
        const newScope = makeScopeKey(org);
        const fallbackLine = org && typeof org.line === 'number' ? org.line : (i + 1);
        registerLabel(pendingDirectiveLabel, addr, org, fallbackLine, newScope);
        pendingDirectiveLabel = null;
      }
      continue;
    }

    if (op === '.ALIGN' || op === 'ALIGN') {
      const exprText = argsAfterToken(line, tokens[0], tokenOffsets[0]).trim();
      if (!exprText.length) {
        errors.push(`Missing value for .align at ${originDesc}`);
        continue;
      }
      const ctx: ExpressionEvalContext = { labels, consts, localsIndex, scopes, lineIndex: i + 1 };
      let alignment = 0;
      try {
        alignment = evaluateConditionExpression(exprText, ctx, true);
      } catch (err: any) {
        errors.push(`Failed to evaluate .align at ${originDesc}: ${err?.message || err}`);
        continue;
      }
      if (alignment <= 0) {
        errors.push(`.align value must be positive at ${originDesc}`);
        continue;
      }
      if ((alignment & (alignment - 1)) !== 0) {
        errors.push(`.align value must be a power of two at ${originDesc}`);
        continue;
      }
      const remainder = addr % alignment;
      const alignedAddr = remainder === 0 ? addr : addr + (alignment - remainder);
      if (alignedAddr > 0x10000) {
        errors.push(`.align would move address beyond 0x10000 at ${originDesc}`);
        continue;
      }
      alignDirectives[i] = { value: alignment };
      if (pendingDirectiveLabel) {
        const origin = origins[i];
        const fallbackLine = origin && typeof origin.line === 'number' ? origin.line : (i + 1);
        registerLabel(pendingDirectiveLabel, alignedAddr, origin, fallbackLine, scopes[i]);
        pendingDirectiveLabel = null;
      }
      addr = alignedAddr;
      continue;
    }

    const instrSizes: Record<string, number> = {
      'NOP': 1,
      'LXI': 3,
      'STAX': 1, 'LDAX': 1,
      'SHLD': 3, 'LHLD': 3,
      'STA': 3, 'LDA': 3,
      'INX': 1, 'DCX': 1, 'INR': 1, 'DCR': 1,
      'MVI': 2,
      'RLC': 1, 'RAL': 1, 'DAA': 1, 'STC': 1,
      'DAD': 1,
      'RRC': 1, 'RAR': 1, 'CMA': 1, 'CMC': 1,
      'MOV': 1,
      'HLT': 1,
      'ADD': 1, 'ADC': 1,
      'SUB': 1, 'SBB': 1,
      'ANA': 1, 'XRA': 1,
      'ORA': 1, 'CMP': 1,
      'RNZ': 1, 'RNC': 1, 'RPO': 1, 'RP': 1,
      'POP': 1, 'PUSH': 1,
      'JNZ': 3, 'JNC': 3, 'JPO': 3, 'JP': 3,
      'JMP': 3, 'OUT': 2, 'XTHL': 1, 'DI': 1,
      'CNZ': 3, 'CNC': 3, 'CPO': 3, 'CP': 3,
      'ADI': 2, 'SUI': 2, 'ANI': 2, 'ORI': 2,
      'RST': 1,
      'RZ': 1, 'RC': 1, 'RPE': 1, 'RM': 1,
      'RET': 1, 'PCHL': 1, 'SPHL': 1,
      'JZ': 3, 'JC': 3, 'JPE': 3, 'JM': 3,
      'IN': 2, 'XCHG': 1, 'EI': 1,
      'CZ': 3, 'CC': 3, 'CPE': 3, 'CM': 3,
      'CALL': 3,
      'ACI': 2, 'SBI': 2, 'XRI': 2, 'CPI': 2,
    }

    if (instrSizes.hasOwnProperty(op)) {
      addr += instrSizes[op];
      continue;
    }

    // unknown -> error
    errors.push(`Unknown or unsupported opcode '${op}' at line ${i + 1}`);
  }

  if (ifStack.length) {
    for (let idx = ifStack.length - 1; idx >= 0; idx--) {
      const frame = ifStack[idx];
      errors.push(`Missing .endif for .if at ${describeOrigin(frame.origin, frame.lineIndex, sourcePath)}`);
    }
  }

  if (errors.length) return { success: false, errors, origins };





  //////////////////////////////////////////////////////////////////////////////
  //
  // Second pass: generate bytes and source-line map
  //
  //////////////////////////////////////////////////////////////////////////////

  addr = 0;
  const out: number[] = [];
  const map: Record<number, number> = {};
  const dataLineSpans: Array<{ start: number; byteLength: number; unitBytes: number } | undefined> = new Array(lines.length);
  const directiveCtxSecond: DirectiveContext = {
    labels,
    consts,
    variables,
    errors,
    warnings,
    printMessages,
    textEncoding: 'ascii',
    textCase: 'mixed',
    localsIndex,
    scopes
  };
  const dataCtxSecond: DataContext = { labels, consts, localsIndex, scopes, errors };
  const instrCtx: InstructionContext = { labels, consts, localsIndex, scopes, errors };

  const ifStackSecond: IfFrame[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const srcLine = i + 1;
    const line = stripInlineComment(raw).trim();
    if (!line) continue;

    const originDesc = describeOrigin(origins[i], srcLine, sourcePath);

    const labelIfMatch = line.match(/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:?\s*\.if\b/i);
    if (labelIfMatch && line[0] !== '.') {
      errors.push(`Labels are not allowed on .if directives at ${originDesc}`);
      continue;
    }
    const labelEndifMatch = line.match(/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:?\s*\.endif\b/i);
    if (labelEndifMatch && line[0] !== '.') {
      errors.push(`Labels are not allowed on .endif directives at ${originDesc}`);
      continue;
    }
    const labelPrintMatch = line.match(/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:?\s*\.print\b/i);
    if (labelPrintMatch && line[0] !== '.') {
      errors.push(`Labels are not allowed on .print directives at ${originDesc}`);
      continue;
    }
    const labelErrorMatch = line.match(/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:?\s*\.error\b/i);
    if (labelErrorMatch && line[0] !== '.') {
      errors.push(`Labels are not allowed on .error directives at ${originDesc}`);
      continue;
    }
    const labelVarMatch = line.match(/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:\s*[A-Za-z_][A-Za-z0-9_]*\s+\.var\b/i);
    if (labelVarMatch) {
      errors.push(`Labels are not allowed on .var directives at ${originDesc}`);
      continue;
    }

    const endifMatch = line.match(/^\.endif\b(.*)$/i);
    if (endifMatch) {
      const remainder = (endifMatch[1] || '').trim();
      if (remainder.length) errors.push(`Unexpected tokens after .endif at ${originDesc}`);
      if (!ifStackSecond.length) errors.push(`.endif without matching .if at ${originDesc}`);
      else ifStackSecond.pop();
      continue;
    }

    const ifMatch = line.match(/^\.if\b(.*)$/i);
    if (ifMatch) {
      const expr = (ifMatch[1] || '').trim();
      const parentActive = ifStackSecond.length === 0 ? true : ifStackSecond[ifStackSecond.length - 1].effective;
      if (!expr.length) {
        errors.push(`Missing expression for .if at ${originDesc}`);
        ifStackSecond.push({ effective: false, suppressed: !parentActive, origin: origins[i], lineIndex: srcLine });
        continue;
      }
      const ctx: ExpressionEvalContext = { labels, consts, localsIndex, scopes, lineIndex: srcLine };
      let conditionResult = false;
      if (!parentActive) {
        try {
          evaluateConditionExpression(expr, ctx, false);
        } catch (err: any) {
          errors.push(`Failed to parse .if expression at ${originDesc}: ${err?.message || err}`);
        }
      } else {
        try {
          const value = evaluateConditionExpression(expr, ctx, true);
          conditionResult = value !== 0;
        } catch (err: any) {
          errors.push(`Failed to evaluate .if at ${originDesc}: ${err?.message || err}`);
          conditionResult = false;
        }
      }
      const effective = parentActive && conditionResult;
      ifStackSecond.push({ effective, suppressed: !parentActive, origin: origins[i], lineIndex: srcLine });
      continue;
    }

    const blockActive = ifStackSecond.length === 0 ? true : ifStackSecond[ifStackSecond.length - 1].effective;
    if (!blockActive) continue;

    if (handlePrintDirective(line, origins[i], srcLine, sourcePath, directiveCtxSecond)) {
      map[srcLine] = addr;
      continue;
    }

    if (handleErrorDirective(line, origins[i], srcLine, sourcePath, directiveCtxSecond)) {
      map[srcLine] = addr;
      return { success: false, errors, origins };
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*:$/.test(line)) continue; // label only

    // Skip .var directive in second pass (already processed in first pass)
    if (/^[A-Za-z_][A-Za-z0-9_]*\s+\.var\b/i.test(line)) {
      continue;
    }

    const tokenizedSecond = tokenize(line);
    const tokens = tokenizedSecond.tokens;
    const tokenOffsets = tokenizedSecond.offsets;
    if (!tokens.length) continue;
    if (tokens[0].endsWith(':')) {
      tokens.shift();
      tokenOffsets.shift();
      if (!tokens.length) { map[srcLine] = addr; continue; }
    } else if (tokens.length >= 2 && /^\.?org$/i.test(tokens[1])) {
      tokens.shift();
      tokenOffsets.shift();
    }

    map[srcLine] = addr;
    const lineStartAddr = addr;

    // Process variable assignments in second pass, but skip constant assignments
    if (tokens.length >= 3 && (tokens[1] === '=' || tokens[1].toUpperCase() === 'EQU')) {
      const name = tokens[0];
      if (variables.has(name)) {
        // This is a variable assignment - process it
        const rhs = tokens.slice(2).join(' ').trim();
        processVariableAssignment(name, rhs, srcLine, originDesc, evalState, errors);
      }
      // Skip in second pass (constants were already processed in first pass)
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line) || /^[A-Za-z_][A-Za-z0-9_]*\s+EQU\b/i.test(line)) {
      // Check if this is a variable assignment
      const assignMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|EQU)\s*(.+)$/i);
      if (assignMatch) {
        const name = assignMatch[1];
        if (variables.has(name)) {
          const rhs = assignMatch[2].trim();
          processVariableAssignment(name, rhs, srcLine, originDesc, evalState, errors);
        }
      }
      continue;
    }

    const op = tokens[0].toUpperCase();

    if (op === 'DB' || op === '.BYTE') {
      const emitted = handleDB(line, tokens, tokenOffsets, srcLine, origins[i], sourcePath, dataCtxSecond, out);
      if (emitted > 0) {
        dataLineSpans[i] = { start: lineStartAddr, byteLength: emitted, unitBytes: 1 };
      }
      addr += emitted;
      continue;
    }

    if (op === 'DW' || op === '.WORD') {
      const emitted = handleDW(line, tokens, tokenOffsets, srcLine, origins[i], sourcePath, dataCtxSecond, out);
      if (emitted > 0) {
        dataLineSpans[i] = { start: lineStartAddr, byteLength: emitted, unitBytes: 2 };
      }
      addr += emitted;
      continue;
    }

    if (op === 'DS') {
      const emitted = handleDS(line, tokens, tokenOffsets, srcLine, dataCtxSecond);
      addr += emitted;
      continue;
    }

    if (op === '.ORG' || op === 'ORG') {
      const rest = argsAfterToken(line, tokens[0], tokenOffsets[0]);
      const aTok = rest.trim().split(/\s+/)[0];
      const val = parseAddressToken(aTok, labels, consts);
      if (val === null) { errors.push(`Bad ${op} address '${aTok}' at ${srcLine}`); continue; }
      addr = val;
      // label for this ORG (if present) was already registered in first pass; nothing to emit
      continue;
    }

    if (op === '.ALIGN' || op === 'ALIGN') {
      const directive = alignDirectives[i];
      if (!directive) { continue; }
      const alignment = directive.value;
      if (alignment <= 0) { continue; }
      const remainder = addr % alignment;
      if (remainder === 0) { continue; }
      const gap = alignment - remainder;
      for (let k = 0; k < gap; k++) out.push(0);
      addr += gap;
      continue;
    }

    if (op === '.ENCODING'){
      handleEncodingDirective(line, origins[i], srcLine, sourcePath, directiveCtxSecond, tokenOffsets, tokens);
      continue;
    }

    const textAddrRef = { value: addr };

    if (op === '.TEXT') {
      addr = handleTextDirective(
        line,
        origins[i],
        srcLine,
        sourcePath,
        directiveCtxSecond,
        tokenOffsets,
        tokens,
        out,
        textAddrRef
      );
      continue;
    }

    if (op === 'LDAX' || op === 'STAX') {
      const reg = tokens[1].toUpperCase();
      let opcode = -1;
      if (op === 'LDAX') {
        if (reg === 'B') opcode = 0x0A;
        if (reg === 'D') opcode = 0x1A;
      } else {
        if (reg === 'B') opcode = 0x02;
        if (reg === 'D') opcode = 0x12;
      }
      if (opcode < 0) { errors.push(`Bad ${op} register '${reg}' at ${srcLine}`); continue; }
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    if (op === 'INX' || op === 'DCX') {
      const rp = tokens[1].toUpperCase();
      const isInx = op === 'INX';
      let opcode = -1;
      if (rp === 'B') opcode = isInx ? 0x03 : 0x0B;
      if (rp === 'D') opcode = isInx ? 0x13 : 0x1B;
      if (rp === 'H') opcode = isInx ? 0x23 : 0x2B;
      if (rp === 'SP') opcode = isInx ? 0x33 : 0x3B;
      if (opcode < 0) { errors.push(`Bad ${op} RP '${rp}' at ${srcLine}`); continue; }
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    if (op === 'LHLD' || op === 'SHLD') {
      const opcode = op === 'LHLD' ? 0x2A : 0x22;
      const emitted = encodeThreeByteAddress(tokens, srcLine, opcode, instrCtx, out);
      addr += emitted;
      continue;
    }

    if (op === 'XCHG') { out.push(0xEB); addr += 1; continue; }
    if (op === 'PCHL') { out.push(0xE9); addr += 1; continue; }
    if (op === 'SPHL') { out.push(0xF9); addr += 1; continue; }
    if (op === 'XTHL') { out.push(0xE3); addr += 1; continue; }

    if (op === 'MVI') {
      const emitted = encodeMVI(line, srcLine, instrCtx, out);
      addr += emitted;
      continue;
    }

    if (op === 'MOV') {
      const emitted = encodeMOV(tokens, srcLine, instrCtx, out);
      addr += emitted;
      continue;
    }

    const threeByteMap: Record<string, number> = {
      'LDA': 0x3A,
      'STA': 0x32,
      'JMP': 0xC3,
      'JZ': 0xCA,
      'JNZ': 0xC2,
      'CALL': 0xCD
    };
    if (op in threeByteMap) {
      const emitted = encodeThreeByteAddress(tokens, srcLine, threeByteMap[op], instrCtx, out);
      addr += emitted;
      continue;
    }

    if (op === 'LXI') {
      const emitted = encodeLXI(line, srcLine, instrCtx, out);
      addr += emitted;
      continue;
    }

    const regOpMap: Record<string, number> = {
      'ADD': 0x80,
      'ADC': 0x88,
      'SUB': 0x90,
      'SBB': 0x98
    };
    if (op in regOpMap) {
      const emitted = encodeRegisterOp(tokens, srcLine, regOpMap[op], instrCtx, out);
      addr += emitted;
      continue;
    }

    if (op === 'INR' || op === 'DCR') {
      // INR r or DCR r
      const r = tokens[1].toUpperCase();
      if (!(r in regCodes)) { errors.push(`Bad ${op} reg at ${srcLine}`); continue; }
      const base = op === 'INR' ? 0x04 : 0x05;
      const opcode = base + (regCodes[r] << 3);
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    const logicRegMap: Record<string, number> = {
      'ANA': 0xA0,
      'XRA': 0xA8,
      'ORA': 0xB0,
      'CMP': 0xB8
    };
    if (op in logicRegMap) {
      const emitted = encodeRegisterOp(tokens, srcLine, logicRegMap[op], instrCtx, out);
      addr += emitted;
      continue;
    }

    const immArithMap: Record<string, number> = { 'ADI': 0xC6, 'ACI': 0xCE, 'SUI': 0xD6, 'SBI': 0xDE };
    if (op in immArithMap) {
      const emitted = encodeImmediateOp(tokens, srcLine, immArithMap[op], instrCtx, out);
      addr += emitted;
      continue;
    }

    const immLogicMap: Record<string, number> = { 'ANI': 0xE6, 'XRI': 0xEE, 'ORI': 0xF6, 'CPI': 0xFE };
    if (op in immLogicMap) {
      const emitted = encodeImmediateOp(tokens, srcLine, immLogicMap[op], instrCtx, out);
      addr += emitted;
      continue;
    }

    // DAD RP
    if (op === 'DAD') {
      const rp = tokens[1].toUpperCase();
      let opcode = -1;
      if (rp === 'B') opcode = 0x09;
      if (rp === 'D') opcode = 0x19;
      if (rp === 'H') opcode = 0x29;
      if (rp === 'SP') opcode = 0x39;
      if (opcode < 0) { errors.push(`Bad DAD RP '${rp}' at ${srcLine}`); continue; }
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    // Rotates
    if (op === 'RLC') { out.push(0x07); addr += 1; continue; }
    if (op === 'RRC') { out.push(0x0F); addr += 1; continue; }
    if (op === 'RAL') { out.push(0x17); addr += 1; continue; }
    if (op === 'RAR') { out.push(0x1F); addr += 1; continue; }

    // EI/DI
    if (op === 'EI') { out.push(0xFB); addr += 1; continue; }
    if (op === 'DI') { out.push(0xF3); addr += 1; continue; }

    // PUSH/POP
    if (op === 'PUSH') {
      const rp = tokens[1].toUpperCase();
      let opcode = -1;
      if (rp === 'B') opcode = 0xC5;
      if (rp === 'D') opcode = 0xD5;
      if (rp === 'H') opcode = 0xE5;
      if (rp === 'PSW' || rp === 'PSW,' ) opcode = 0xF5;
      if (opcode < 0) { errors.push(`Bad PUSH RP '${rp}' at ${srcLine}`); continue; }
      out.push(opcode & 0xff); addr += 1; continue;
    }

    if (op === 'POP') {
      const rp = tokens[1].toUpperCase();
      let opcode = -1;
      if (rp === 'B') opcode = 0xC1;
      if (rp === 'D') opcode = 0xD1;
      if (rp === 'H') opcode = 0xE1;
      if (rp === 'PSW' || rp === 'PSW,') opcode = 0xF1;
      if (opcode < 0) { errors.push(`Bad POP RP '${rp}' at ${srcLine}`); continue; }
      out.push(opcode & 0xff); addr += 1; continue;
    }

    // IN/OUT
    if (op === 'IN') {
      const emitted = encodeImmediateOp(tokens, srcLine, 0xDB, instrCtx, out);
      addr += emitted;
      continue;
    }
    if (op === 'OUT') {
      const emitted = encodeImmediateOp(tokens, srcLine, 0xD3, instrCtx, out);
      addr += emitted;
      continue;
    }

    // RST n
    if (op === 'RST') {
      const n = parseInt(tokens[1]);
      if (isNaN(n) || n < 0 || n > 7) { errors.push(`Bad RST vector '${tokens[1]}' at ${srcLine}`); continue; }
      out.push((0xC7 + (n << 3)) & 0xff); addr += 1; continue;
    }

    // Conditional jumps and calls
    const jmpMap: Record<string, number> = { 'JNZ': 0xC2, 'JZ': 0xCA, 'JNC': 0xD2, 'JC': 0xDA, 'JPO': 0xE2, 'JPE': 0xEA, 'JP': 0xF2, 'JM': 0xFA };
    const callMap: Record<string, number> = { 'CNZ': 0xC4, 'CZ': 0xCC, 'CNC': 0xD4, 'CC': 0xDC, 'CPO': 0xE4, 'CPE': 0xEC, 'CP': 0xF4, 'CM': 0xFC };
    const retMap: Record<string, number> = { 'RNZ': 0xC0, 'RZ': 0xC8, 'RNC': 0xD0, 'RC': 0xD8, 'RPO': 0xE0, 'RPE': 0xE8, 'RP': 0xF0, 'RM': 0xF8 };

    if (op in jmpMap) {
      const emitted = encodeThreeByteAddress(tokens, srcLine, jmpMap[op], instrCtx, out);
      addr += emitted;
      continue;
    }

    if (op in callMap) {
      const emitted = encodeThreeByteAddress(tokens, srcLine, callMap[op], instrCtx, out);
      addr += emitted;
      continue;
    }

    if (op in retMap) { out.push(retMap[op]); addr += 1; continue; }

    // DAA, STC, CMC
    if (op === 'DAA') { out.push(0x27); addr += 1; continue; }
    if (op === 'STC') { out.push(0x37); addr += 1; continue; }
    if (op === 'CMC') { out.push(0x3F); addr += 1; continue; }

    if (op === 'RET') { out.push(0xC9); addr += 1; continue; }

    if (op === 'HLT') { out.push(0x76); addr += 1; continue; }
    if (op === 'NOP') { out.push(0x00); addr += 1; continue; }

    errors.push(`Unhandled opcode '${op}' at ${srcLine}`);
  }

  if (ifStackSecond.length) {
    for (let idx = ifStackSecond.length - 1; idx >= 0; idx--) {
      const frame = ifStackSecond[idx];
      errors.push(`Missing .endif for .if at ${describeOrigin(frame.origin, frame.lineIndex, sourcePath)}`);
    }
  }

  if (errors.length) return { success: false, errors, origins };

  // convert labels map to plain object for return
  const labelsOut: Record<string, { addr: number; line: number; src?: string }> = {};
  for (const [k, v] of labels) labelsOut[k] = { addr: v.addr, line: v.line, src: v.src };
  const constsOut: Record<string, number> = {};
  for (const [k, v] of consts) constsOut[k] = v;
  const dataSpanOut: Record<number, { start: number; byteLength: number; unitBytes: number }> = {};
  for (let idx = 0; idx < dataLineSpans.length; idx++) {
    const span = dataLineSpans[idx];
    if (!span) continue;
    dataSpanOut[idx + 1] = span;
  }

  return {
    success: true,
    output: Buffer.from(out),
    map,
    labels: labelsOut,
    consts: constsOut,
    dataLineSpans: dataSpanOut,
    warnings,
    printMessages,
    origins };
}

// convenience when using from extension
export const assembleAndWrite = createAssembleAndWrite(assemble);
