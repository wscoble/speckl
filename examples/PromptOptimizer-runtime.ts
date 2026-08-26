// PromptOptimizer runtime — implements actual LLM prompt optimization logic
// The generated PromptOptimizerMachine handles state transitions, guards, and events.
// This module provides the functions that make it actually work.

// ─── Token Counting ────────────────────────────────────────

// Approximate token count for LLM models (GPT-4/Claude style: ~4 chars per token)
export function countTokens(text: string, model: string = 'gpt-4'): number {
  if (!text) return 0;
  // GPT-4 style: ~4 chars per token, with adjustments for code/special chars
  const specialCharPenalty = (text.match(/[{}[\]()<>\/\\|`~!@#$%^&*]/g) || []).length;
  const whitespaceTokens = (text.match(/\s{2,}/g) || []).length;
  const baseTokens = Math.ceil(text.length / 4);
  return baseTokens + Math.ceil(specialCharPenalty * 0.2) + whitespaceTokens;
}

// ─── Prompt Analysis ───────────────────────────────────────

export interface PromptAnalysis {
  tokenCount: number;
  redundancyScore: number;      // 0-1, higher = more redundant
  structureScore: number;       // 0-1, higher = better organized
  constraintCount: number;
  instructionCount: number;
  estimatedQuality: number;     // 0-1
  issues: string[];
  sections: PromptSection[];
  duplicatedPhrases: DuplicatedPhrase[];
  vagueInstructions: string[];
}

export interface PromptSection {
  type: 'instruction' | 'constraint' | 'example' | 'context' | 'format' | 'role' | 'tone';
  text: string;
  tokenCount: number;
  priority: number;  // 1=critical, 2=important, 3=nice-to-have
}

export interface DuplicatedPhrase {
  phrase: string;
  occurrences: number;
  savings: number;  // tokens saved by deduplicating
}

export function analyzePrompt(prompt: string, context: string = 'system', model: string = 'gpt-4'): PromptAnalysis {
  const tokenCount = countTokens(prompt, model);
  const sections = extractSections(prompt);
  const duplicatedPhrases = findDuplicatedPhrases(prompt, sections);
  const vagueInstructions = findVagueInstructions(prompt);
  const constraintCount = countConstraints(prompt);
  const instructionCount = countInstructions(prompt);
  const redundancyScore = calculateRedundancyScore(prompt, duplicatedPhrases);
  const structureScore = calculateStructureScore(sections);
  const estimatedQuality = calculateQualityScore(redundancyScore, structureScore, vagueInstructions, constraintCount);
  const issues = identifyIssues(redundancyScore, structureScore, vagueInstructions, duplicatedPhrases);

  return {
    tokenCount,
    redundancyScore,
    structureScore,
    constraintCount,
    instructionCount,
    estimatedQuality,
    issues,
    sections,
    duplicatedPhrases,
    vagueInstructions
  };
}

// ─── Section Extraction ─────────────────────────────────────

function extractSections(prompt: string): PromptSection[] {
  const sections: PromptSection[] = [];
  const lines = prompt.split('\n');
  let currentSection: PromptSection | null = null;
  let currentText: string[] = [];

  const sectionHeaders: Record<string, PromptSection['type']> = {
    'you are': 'role',
    'your role': 'role',
    'role': 'role',
    'instructions': 'instruction',
    'rules': 'constraint',
    'constraints': 'constraint',
    'requirements': 'constraint',
    'guidelines': 'instruction',
    'format': 'format',
    'output format': 'format',
    'response format': 'format',
    'example': 'example',
    'examples': 'example',
    'context': 'context',
    'background': 'context',
    'tone': 'tone',
    'style': 'tone',
    'voice': 'tone',
  };

  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    const isHeader = trimmed.startsWith('#') || trimmed.startsWith('##') ||
                     trimmed.endsWith(':') || trimmed.startsWith('- ');

    // Check if this line is a section header
    let foundType: PromptSection['type'] | null = null;
    for (const [keyword, type] of Object.entries(sectionHeaders)) {
      if (trimmed.includes(keyword)) {
        foundType = type;
        break;
      }
    }

    if (foundType && (trimmed.startsWith('#') || trimmed.endsWith(':') || trimmed.startsWith('**'))) {
      // Save previous section
      if (currentSection && currentText.length > 0) {
        currentSection.text = currentText.join('\n');
        currentSection.tokenCount = countTokens(currentSection.text);
        sections.push(currentSection);
      }
      currentSection = { type: foundType, text: '', tokenCount: 0, priority: getPriority(foundType) };
      currentText = [line];
    } else if (currentSection) {
      currentText.push(line);
    } else {
      // Unaffiliated content — treat as context/instruction
      if (line.trim()) {
        currentSection = { type: 'instruction', text: '', tokenCount: 0, priority: 2 };
        currentText = [line];
      }
    }
  }

  // Save last section
  if (currentSection && currentText.length > 0) {
    currentSection.text = currentText.join('\n');
    currentSection.tokenCount = countTokens(currentSection.text);
    sections.push(currentSection);
  }

  // If no sections found, treat entire prompt as one instruction section
  if (sections.length === 0 && prompt.trim()) {
    sections.push({
      type: 'instruction',
      text: prompt,
      tokenCount: countTokens(prompt),
      priority: 2
    });
  }

  return sections;
}

function getPriority(type: PromptSection['type']): number {
  switch (type) {
    case 'constraint': return 1;  // constraints are critical
    case 'role': return 1;         // role definition is critical
    case 'instruction': return 2;  // instructions are important
    case 'format': return 2;       // format is important
    case 'context': return 3;      // context is nice-to-have
    case 'example': return 3;      // examples can be trimmed
    case 'tone': return 3;        // tone is nice-to-have
    default: return 2;
  }
}

// ─── Redundancy Detection ──────────────────────────────────

function findDuplicatedPhrases(prompt: string, sections: PromptSection[]): DuplicatedPhrase[] {
  const phrases: DuplicatedPhrase[] = [];
  const seen = new Map<string, number>();

  // Extract meaningful phrases (3-6 words)
  const words = prompt.split(/\s+/);
  for (let len = 3; len <= 6; len++) {
    for (let i = 0; i <= words.length - len; i++) {
      const phrase = words.slice(i, i + len).join(' ').toLowerCase().replace(/[.,;:!?]/g, '');
      if (phrase.length < 10) continue;  // skip very short phrases
      if (/^(the|a|an|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|could|should|may|might|shall|can|need|dare|ought|used|to|of|in|for|on|with|at|by|from|as|into|through|during|before|after|above|below|between|out|off|over|under|again|further|then|once|and|but|or|nor|not|so|yet)\b/i.test(phrase)) continue;

      seen.set(phrase, (seen.get(phrase) || 0) + 1);
    }
  }

  // Only report phrases that appear 2+ times
  for (const [phrase, count] of seen) {
    if (count >= 2) {
      phrases.push({
        phrase,
        occurrences: count,
        savings: countTokens(phrase) * (count - 1)
      });
    }
  }

  // Sort by savings descending
  return phrases.sort((a, b) => b.savings - a.savings).slice(0, 10);
}

// ─── Vague Instruction Detection ────────────────────────────

const VAGUE_PATTERNS = [
  /\b(be|act|respond|write|create|make|generate|produce|provide)\s+(good|nice|great|excellent|appropriate|reasonable|proper|suitable|relevant|helpful|clear)\b/gi,
  /\b(try|attempt|endeavor|strive)\s+to\b/gi,
  /\bas\s+(needed|appropriate|necessary|required|suitable)\b/gi,
  /\b(make\s+sure|ensure)\s+(that\s+)?(it|the|this|your)\b/gi,
  /\b(etc\.?|and\s+so\s+on|and\s+so\s+forth|and\s+the\s+like)\b/gi,
];

function findVagueInstructions(prompt: string): string[] {
  const found: string[] = [];
  for (const pattern of VAGUE_PATTERNS) {
    const matches = prompt.matchAll(pattern);
    for (const m of matches) {
      found.push(m[0]);
    }
  }
  return [...new Set(found)];
}

// ─── Constraint & Instruction Counting ──────────────────────

function countConstraints(prompt: string): number {
  const patterns = [
    /\b(must|shall|required|mandatory|always|never|do\s+not|don't|cannot|can't|never|forbidden|prohibited)\b/gi,
    /\b(no|without|exclude|avoid|prevent|refrain)\b/gi,
  ];
  let count = 0;
  for (const p of patterns) {
    const matches = prompt.match(p);
    count += matches ? matches.length : 0;
  }
  return count;
}

function countInstructions(prompt: string): number {
  const imperatives = prompt.match(/\b(Write|Create|Generate|Build|Implement|Design|Analyze|Review|Check|Ensure|Provide|List|Describe|Explain|Compare|Summarize|Convert|Translate|Format)\b/gi);
  return imperatives ? imperatives.length : 0;
}

// ─── Score Calculation ─────────────────────────────────────

function calculateRedundancyScore(prompt: string, duplicates: DuplicatedPhrase[]): number {
  if (duplicates.length === 0) return 0.0;
  const totalDuplicateTokens = duplicates.reduce((sum, d) => sum + d.savings, 0);
  const totalTokens = countTokens(prompt);
  if (totalTokens === 0) return 0.0;
  return Math.min(1.0, totalDuplicateTokens / totalTokens);
}

function calculateStructureScore(sections: PromptSection[]): number {
  if (sections.length === 0) return 0.0;
  if (sections.length === 1) return 0.3; // just a blob

  const hasRole = sections.some(s => s.type === 'role');
  const hasInstructions = sections.some(s => s.type === 'instruction');
  const hasConstraints = sections.some(s => s.type === 'constraint');
  const hasFormat = sections.some(s => s.type === 'format');

  let score = 0.3; // baseline for having multiple sections
  if (hasRole) score += 0.2;
  if (hasInstructions) score += 0.2;
  if (hasConstraints) score += 0.15;
  if (hasFormat) score += 0.15;

  return Math.min(1.0, score);
}

function calculateQualityScore(
  redundancy: number,
  structure: number,
  vagueInstructions: string[],
  constraintCount: number
): number {
  // Start at 0.5, penalize for problems, reward for good structure
  let score = 0.5;

  // Redundancy is bad — up to -0.3
  score -= redundancy * 0.3;

  // Good structure is good — up to +0.2
  score += (structure - 0.5) * 0.4;

  // Vague instructions are bad — up to -0.1
  score -= Math.min(0.1, vagueInstructions.length * 0.02);

  // Having constraints is good — up to +0.1
  score += Math.min(0.1, constraintCount * 0.01);

  return Math.max(0.0, Math.min(1.0, score));
}

function identifyIssues(
  redundancy: number,
  structure: number,
  vague: string[],
  duplicates: DuplicatedPhrase[]
): string[] {
  const issues: string[] = [];

  if (redundancy > 0.3) issues.push('High redundancy — consider removing duplicated phrases');
  if (redundancy > 0.15 && redundancy <= 0.3) issues.push('Moderate redundancy — some phrases appear multiple times');

  if (structure < 0.4) issues.push('Poor structure — no clear sections or headers');
  else if (structure < 0.6) issues.push('Moderate structure — consider adding headers for key sections');

  if (vague.length > 0) issues.push(`Vague instructions found: "${vague.slice(0, 3).join('", "')}"`);

  if (duplicates.length > 3) issues.push(`${duplicates.length} duplicated phrases found — deduplication could save ${duplicates.reduce((s, d) => s + d.savings, 0)} tokens`);

  return issues;
}

// ─── Optimization Strategies ────────────────────────────────

export function rewritePrompt(
  prompt: string,
  strategy: string,
  analysis: PromptAnalysis
): string {
  switch (strategy) {
    case 'reorder':
      return reorderSections(prompt, analysis);
    case 'deduplicate':
      return deduplicatePrompt(prompt, analysis);
    case 'concretize':
      return concretizeInstructions(prompt, analysis);
    case 'decompose':
      return decomposePrompt(prompt, analysis);
    default:
      return prompt;
  }
}

// ─── Reorder: put critical sections first ────────────────────

function reorderSections(prompt: string, analysis: PromptAnalysis): string {
  if (analysis.sections.length <= 1) return prompt;

  // Sort by priority (1 first), then by type
  const typeOrder: Record<string, number> = {
    'role': 1,
    'constraint': 2,
    'instruction': 3,
    'format': 4,
    'context': 5,
    'example': 6,
    'tone': 7,
  };

  const sorted = [...analysis.sections].sort((a, b) => {
    const aOrder = typeOrder[a.type] ?? 4;
    const bOrder = typeOrder[b.type] ?? 4;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.priority - b.priority;
  });

  return sorted.map(s => s.text.trim()).filter(Boolean).join('\n\n');
}

// ─── Deduplicate: remove duplicated sentences and phrases ────────────

function deduplicatePrompt(prompt: string, analysis: PromptAnalysis): string {
  // Strategy: find duplicate sentences and remove later occurrences
  const sentences = prompt.split(/(?<=[.!?])\s+/);
  const seen = new Map<string, number>();
  const result: string[] = [];

  for (const sentence of sentences) {
    const normalized = sentence.toLowerCase().trim().replace(/\s+/g, ' ');
    // Skip very short fragments
    if (normalized.length < 15) {
      result.push(sentence);
      continue;
    }
    if (seen.has(normalized)) {
      // Skip duplicate sentence
      continue;
    }
    seen.set(normalized, 1);
    result.push(sentence);
  }

  return result.join(' ').replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Concretize: replace vague instructions ─────────────────

const CONCRETIZATIONS: [RegExp, string][] = [
  [/write good\s+responses/gi, 'write clear, specific responses'],
  [/write great\s+responses/gi, 'write thorough, well-organized responses'],
  [/write nice\s+/gi, 'write polished '],
  [/be helpful/gi, 'provide actionable, specific responses'],
  [/be clear/gi, 'use short sentences, active voice'],
  [/respond appropriately/gi, 'respond with a direct answer first'],
  [/as needed/gi, 'when required'],
  [/as appropriate/gi, 'matching the context'],
  [/make sure that/gi, 'verify that'],
  [/ensure that/gi, 'verify that'],
  [/try to\s+/gi, ''],  // just remove hedging
  [/in other words[,\s]*/gi, ''],  // remove wordy transitions
  [/for example,?\s+/gi, 'e.g., '],
  [/for instance,?\s+/gi, 'e.g., '],
  [/that is to say[,\s]*/gi, ''],
];

function concretizeInstructions(prompt: string, analysis: PromptAnalysis): string {
  let result = prompt;
  for (const [pattern, replacement] of CONCRETIZATIONS) {
    result = result.replace(pattern, replacement);
  }
  // Clean up artifacts from replacements
  result = result
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*[,;.]\s*/gm, '')  // remove leading punctuation
    .trim();
  return result;
}

// ─── Decompose: split into numbered steps ────────────────────

function decomposePrompt(prompt: string, analysis: PromptAnalysis): string {
  // If already has numbered sections, skip
  if (/^\d+\.\s/m.test(prompt)) return prompt;

  const lines = prompt.split('\n');
  const instructions = lines.filter(l => {
    const t = l.trim().toLowerCase();
    return /^\s*(write|create|generate|build|implement|design|analyze|review|check|ensure|provide|list|describe|explain|compare|summarize|convert|translate|format)\b/i.test(t);
  });

  if (instructions.length <= 1) return prompt;

  // Add numbers to imperative lines
  let instrIdx = 0;
  const result = lines.map(l => {
    const t = l.trim();
    if (/^\s*(write|create|generate|build|implement|design|analyze|review|check|ensure|provide|list|describe|explain|compare|summarize|convert|translate|format)\b/i.test(t)) {
      instrIdx++;
      return `${instrIdx}. ${t}`;
    }
    return l;
  });

  return result.join('\n');
}

// ─── Compression ────────────────────────────────────────────

export function compressPrompt(prompt: string, targetTokens: number, model: string = 'gpt-4'): string {
  const currentTokens = countTokens(prompt, model);
  if (currentTokens <= targetTokens) return prompt;

  const ratio = targetTokens / currentTokens;
  let result = prompt;

  // Step 1: Remove duplicate phrases
  const analysis = analyzePrompt(result, 'system', model);
  result = deduplicatePrompt(result, analysis);

  // Step 2: Remove filler words and simplify common phrases
  result = result
    .replace(/\b(?:please|kindly|basically|actually|really|very|quite|rather|somewhat|just|simply|merely)\b/gi, '')
    .replace(/\bin order to\b/gi, 'to')
    .replace(/\bdue to the fact that\b/gi, 'because')
    .replace(/\bat this point in time\b/gi, 'now')
    .replace(/\bin the event that\b/gi, 'if')
    .replace(/\bfor the purpose of\b/gi, 'to')
    .replace(/\bit is important to note that\b/gi, '')
    .replace(/\bit should be noted that\b/gi, '')
    .replace(/\bit is worth noting that\b/gi, '')
    .replace(/\bin other words[,\s]*/gi, '')
    .replace(/  +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (countTokens(result, model) <= targetTokens) return result;

  // Step 3: Remove lower-priority sections
  const currentAnalysis = analyzePrompt(result, 'system', model);
  const sortedSections = [...currentAnalysis.sections].sort((a, b) => b.priority - a.priority);

  // Remove sections starting from lowest priority
  for (const section of sortedSections) {
    if (section.priority >= 3) {  // nice-to-have only
      result = result.replace(section.text, '').replace(/\n{3,}/g, '\n\n').trim();
      if (countTokens(result, model) <= targetTokens) return result;
    }
  }

  // Step 4: Shorten remaining sentences (aggressive compression)
  result = result
    .replace(/\b(that is to say)\b[^.]*\./gi, '')
    .replace(/\b(for example|for instance)\b/gi, 'e.g.')
    .replace(/\b(that is)\b/gi, 'i.e.')
    .replace(/\b(information)\b/gi, 'info')
    .replace(/\b(application)\b/gi, 'app')
    .replace(/\b(configuration)\b/gi, 'config')
    .replace(/\b(implementation)\b/gi, 'impl')
    .replace(/\b(documentation)\b/gi, 'docs')
    .replace(/\b(environment)\b/gi, 'env')
    .replace(/\b(percentage)\b/gi, '%')
    .replace(/\b(number)\b/gi, '#')
    .replace(/  +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return result;
}

// ─── Validation ─────────────────────────────────────────────

export function validateOptimization(
  original: string,
  optimized: string,
  criteria: string = 'preserve-intent'
): { passed: boolean; confidence: number; issues: string[] } {
  const issues: string[] = [];
  let confidence = 1.0;

  // Check: must preserve intent (critical keywords)
  const origKeywords = extractKeywords(original);
  const optKeywords = extractKeywords(optimized);
  const missingKeywords = [...origKeywords].filter(k => !optKeywords.has(k));
  const criticalMissing = missingKeywords.filter(k => isCriticalKeyword(k, original));

  if (criticalMissing.length > 0) {
    issues.push(`Critical keywords missing: ${criticalMissing.join(', ')}`);
    confidence -= criticalMissing.length * 0.15;
  }

  // Check: must reduce or maintain tokens
  const origTokens = countTokens(original);
  const optTokens = countTokens(optimized);
  if (optTokens > origTokens) {
    issues.push(`Optimized prompt has MORE tokens (${optTokens}) than original (${origTokens})`);
    confidence -= 0.2;
  }

  // Check: must not be empty
  if (optimized.trim().length === 0) {
    issues.push('Optimized prompt is empty');
    confidence = 0;
  }

  // Check: structural integrity
  const origSections = extractSections(original);
  const optSections = extractSections(optimized);
  const origConstraintCount = origSections.filter(s => s.type === 'constraint').length;
  const optConstraintCount = optSections.filter(s => s.type === 'constraint').length;

  if (optConstraintCount < origConstraintCount) {
    issues.push(`Lost ${origConstraintCount - optConstraintCount} constraint section(s)`);
    confidence -= 0.1 * (origConstraintCount - optConstraintCount);
  }

  return {
    passed: confidence >= 0.6 && criticalMissing.length === 0 && optimized.trim().length > 0,
    confidence: Math.max(0, Math.min(1, confidence)),
    issues
  };
}

function extractKeywords(text: string): Set<string> {
  const stopWords = new Set(['the','a','an','is','are','was','were','be','been','being',
    'have','has','had','do','does','did','will','would','could','should','may','might',
    'shall','can','need','to','of','in','for','on','with','at','by','from','as','into',
    'through','during','before','after','above','below','between','out','off','over',
    'under','again','further','then','once','and','but','or','nor','not','so','yet',
    'both','either','neither','each','every','all','any','few','more','most','other',
    'some','such','no','only','own','same','than','too','very','just','because','if',
    'when','where','how','what','which','who','whom','this','that','these','those',
    'i','me','my','we','our','you','your','he','him','his','she','her','it','its',
    'they','them','their','about','up']);

  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w))
  );
}

function isCriticalKeyword(keyword: string, original: string): boolean {
  // Keywords that appear in imperative/constraint context are critical
  const lower = original.toLowerCase();
  const idx = lower.indexOf(keyword);
  if (idx === -1) return false;

  // Check 50 chars before the keyword for constraint markers
  const context = lower.slice(Math.max(0, idx - 50), idx);
  return /\b(must|shall|never|always|required|mandatory|do not|don't|cannot|forbidden|critical|essential|important)\b/.test(context);
}

// ─── Full Pipeline ──────────────────────────────────────────

export interface OptimizationResult {
  originalPrompt: string;
  optimizedPrompt: string;
  originalTokens: number;
  optimizedTokens: number;
  tokenReduction: number;    // percentage
  strategiesApplied: string[];
  analysis: PromptAnalysis;
  validation: { passed: boolean; confidence: number; issues: string[] };
}

export function optimizePrompt(
  prompt: string,
  context: string = 'system',
  model: string = 'gpt-4',
  targetReduction: number = 0.3  // aim for 30% reduction
): OptimizationResult {
  const originalTokens = countTokens(prompt, model);

  // Phase 1: Analyze
  let analysis = analyzePrompt(prompt, context, model);

  // Phase 2: Determine strategies
  const strategies: string[] = [];
  if (analysis.redundancyScore > 0.1) strategies.push('deduplicate');
  if (analysis.structureScore < 0.6) strategies.push('reorder');
  if (analysis.vagueInstructions.length > 0) strategies.push('concretize');
  if (analysis.instructionCount > 3 && !/^\d+\.\s/m.test(prompt)) strategies.push('decompose');

  // Phase 3: Apply strategies
  let optimized = prompt;
  for (const strategy of strategies) {
    optimized = rewritePrompt(optimized, strategy, analyzePrompt(optimized, context, model));
  }

  // Phase 4: Compress if needed
  const targetTokens = Math.floor(originalTokens * (1 - targetReduction));
  if (countTokens(optimized, model) > targetTokens) {
    optimized = compressPrompt(optimized, targetTokens, model);
    strategies.push('compress');
  }

  // Phase 5: Validate
  const validation = validateOptimization(prompt, optimized);
  const optimizedTokens = countTokens(optimized, model);
  const tokenReduction = originalTokens > 0
    ? Math.round((1 - optimizedTokens / originalTokens) * 100)
    : 0;

  return {
    originalPrompt: prompt,
    optimizedPrompt: optimized,
    originalTokens,
    optimizedTokens,
    tokenReduction,
    strategiesApplied: strategies,
    analysis,
    validation
  };
}

// ─── Demo ───────────────────────────────────────────────────

export function demo(): void {
  const verbosePrompt = `You are a helpful assistant. You should please try to be very helpful and provide good responses that are clear and well-structured. Basically, you need to respond appropriately to each user query and make sure that you give good answers.

You must never reveal sensitive information. You must always verify facts before stating them. You should not make up information that you do not actually know for certain. You must not provide medical advice. You must not provide legal advice.

Please write responses that are nice and well-formatted. Please use markdown formatting where appropriate. Please provide examples when it would be helpful. Please try to explain things in a way that is easy to understand.

In other words, your role is to be a knowledgeable and reliable assistant that prioritizes accuracy and helpfulness. You should always respond in English. You must never respond in any other language.

You are a helpful assistant. You should be helpful and provide good responses. You must always verify facts before stating them. Please provide responses that are clear and well-structured.

For example, if someone asks about a programming concept, you should basically provide a clear explanation with code examples where appropriate. For instance, you might show a simple code snippet to illustrate the point.`;

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Prompt Optimizer — Before & After                          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log();

  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  BEFORE: Original Prompt                                     │');
  console.log('└──────────────────────────────────────────────────────────────┘');
  console.log();
  console.log(verbosePrompt);
  console.log();

  const beforeAnalysis = analyzePrompt(verbosePrompt);
  console.log('Analysis:');
  console.log(`  Tokens:          ${beforeAnalysis.tokenCount}`);
  console.log(`  Redundancy:     ${(beforeAnalysis.redundancyScore * 100).toFixed(1)}%`);
  console.log(`  Structure:      ${(beforeAnalysis.structureScore * 100).toFixed(1)}%`);
  console.log(`  Constraints:    ${beforeAnalysis.constraintCount}`);
  console.log(`  Instructions:   ${beforeAnalysis.instructionCount}`);
  console.log(`  Quality:        ${(beforeAnalysis.estimatedQuality * 100).toFixed(1)}%`);
  console.log(`  Issues:         ${beforeAnalysis.issues.join('; ') || 'None'}`);
  console.log();

  // Optimize
  const result = optimizePrompt(verbosePrompt, 'system', 'gpt-4', 0.4);

  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  AFTER: Optimized Prompt                                     │');
  console.log('└──────────────────────────────────────────────────────────────┘');
  console.log();
  console.log(result.optimizedPrompt);
  console.log();

  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  Summary                                                     │');
  console.log('└──────────────────────────────────────────────────────────────┘');
  console.log(`  Original tokens:    ${result.originalTokens}`);
  console.log(`  Optimized tokens:   ${result.optimizedTokens}`);
  console.log(`  Token reduction:    ${result.tokenReduction}%`);
  console.log(`  Strategies applied: ${result.strategiesApplied.join(' → ')}`);
  console.log(`  Validation:         ${result.validation.passed ? 'PASSED' : 'FAILED'} (confidence: ${(result.validation.confidence * 100).toFixed(0)}%)`);
  if (result.validation.issues.length > 0) {
    console.log(`  Validation issues:  ${result.validation.issues.join('; ')}`);
  }
}