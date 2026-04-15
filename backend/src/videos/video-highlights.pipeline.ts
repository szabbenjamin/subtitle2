import { mkdir, readFile, writeFile } from 'fs/promises';

export const HIGHLIGHT_MODE_VALUES : readonly string[] = ['balanced', 'funny', 'emotional', 'informative', 'dynamic'] as const;
export type HighlightMode = (typeof HIGHLIGHT_MODE_VALUES)[number];

export interface TranscriptCue {
  startSeconds : number;
  endSeconds : number;
  text : string;
}

export interface HighlightFeatureReason {
  key : string;
  label : string;
  value : number;
  normalized : number;
  weight : number;
  contribution : number;
  explanation : string;
}

export interface HighlightCandidate {
  startSeconds : number;
  endSeconds : number;
  score : number;
  transcriptSnippet : string;
  reasons : HighlightFeatureReason[];
  reasonSummary : string;
}

export interface HighlightLearningStat {
  correct : number;
  incorrect : number;
}

export interface HighlightLearningProfile {
  version : number;
  updatedAt : string;
  modes : Record<string, Record<string, HighlightLearningStat>>;
}

const HUNGARIAN_STOPWORDS : ReadonlySet<string> = new Set<string>([
  'a', 'az', 'egy', 'is', 'és', 'hogy', 'ha', 'de', 'mert', 'mint', 'vagy', 'van', 'volt', 'lesz', 'én', 'te', 'ő',
  'mi', 'ti', 'ők', 'ezt', 'azt', 'itt', 'ott', 'ami', 'aki', 'amely', 'minden', 'nagyon', 'akkor', 'most', 'itt', 'ott',
]);

const HUMOR_KEYWORDS : readonly string[] = [
  'vicc', 'vicces', 'poen', 'poenos', 'haha', 'hehe', 'lol', 'nevet', 'rohog', 'szakadok', 'poenkod', 'mem', 'meme',
];

const EMOTION_KEYWORDS : readonly string[] = [
  'szeret', 'boldog', 'orul', 'orom', 'felek', 'szomoru', 'sir', 'koszonom', 'haragszom', 'izgul', 'remelem', 'bocsanat',
];

const INFO_KEYWORDS : readonly string[] = [
  'tip', 'trukk', 'lepes', 'modszer', 'mukodik', 'eloszor', 'masodszor', 'harmadszor', 'osszefoglalva', 'fontos', 'lenyeg',
  'miert', 'hogyan', 'tehat', 'osszesen', 'szazalek', 'adat', 'eredmeny',
];

const DYNAMIC_KEYWORDS : readonly string[] = [
  'gyorsan', 'azonnal', 'most', 'mindjart', 'indul', 'menjunk', 'csinaljuk', 'vagjunk', 'latod', 'figyelj', 'nyomd',
  'futas', 'robban', 'durva', 'komoly',
];

const POSITIVE_KEYWORDS : readonly string[] = [
  'jo', 'szuper', 'kiraly', 'nagyszeru', 'orom', 'siker', 'megold', 'imadom', 'koszi',
];

const NEGATIVE_KEYWORDS : readonly string[] = [
  'rossz', 'hiba', 'baj', 'problema', 'nehez', 'kudarc', 'ideges', 'duh', 'harag', 'felek',
];

const FEATURE_LABELS : Record<string, string> = {
  speechDensity: 'Beszedsuruseg',
  punctuationEnergy: 'Hangulati irasjelek',
  humorSignals: 'Humor jelzesek',
  emotionSignals: 'Erzelmi jelzesek',
  informationSignals: 'Informativ jelzesek',
  dynamicSignals: 'Dinamikus jelzesek',
  sentimentIntensity: 'Erzelmi intenzitas',
  numberDensity: 'Szam/adat suruseg',
  lexicalNovelty: 'Lexikai valtozatossag',
};

const MODE_WEIGHTS : Record<HighlightMode, Record<string, number>> = {
  balanced: {
    speechDensity: 1,
    punctuationEnergy: 0.9,
    humorSignals: 1,
    emotionSignals: 1,
    informationSignals: 1,
    dynamicSignals: 1,
    sentimentIntensity: 0.9,
    numberDensity: 0.7,
    lexicalNovelty: 0.6,
  },
  funny: {
    speechDensity: 0.8,
    punctuationEnergy: 1.3,
    humorSignals: 1.9,
    emotionSignals: 0.5,
    informationSignals: 0.2,
    dynamicSignals: 1.1,
    sentimentIntensity: 1,
    numberDensity: 0.2,
    lexicalNovelty: 0.8,
  },
  emotional: {
    speechDensity: 0.7,
    punctuationEnergy: 1.2,
    humorSignals: 0.3,
    emotionSignals: 1.9,
    informationSignals: 0.4,
    dynamicSignals: 0.8,
    sentimentIntensity: 1.7,
    numberDensity: 0.2,
    lexicalNovelty: 0.8,
  },
  informative: {
    speechDensity: 1.1,
    punctuationEnergy: 0.4,
    humorSignals: 0.3,
    emotionSignals: 0.5,
    informationSignals: 1.9,
    dynamicSignals: 0.6,
    sentimentIntensity: 0.3,
    numberDensity: 1.5,
    lexicalNovelty: 1,
  },
  dynamic: {
    speechDensity: 1.5,
    punctuationEnergy: 1,
    humorSignals: 0.8,
    emotionSignals: 0.7,
    informationSignals: 0.6,
    dynamicSignals: 1.8,
    sentimentIntensity: 0.8,
    numberDensity: 0.5,
    lexicalNovelty: 0.9,
  },
};

export function normalizeHighlightMode(rawMode : string | undefined | null) : HighlightMode {
  if (typeof rawMode !== 'string') {
    return 'balanced';
  }
  const normalized : string = rawMode.trim().toLowerCase();
  if (HIGHLIGHT_MODE_VALUES.includes(normalized)) {
    return normalized as HighlightMode;
  }
  return 'balanced';
}

export function parseSrtCues(transcript : string) : TranscriptCue[] {
  const normalizedTranscript : string = transcript.replace(/\r\n/g, '\n').trim();
  if (normalizedTranscript.length === 0) {
    return [];
  }

  const cues : TranscriptCue[] = [];
  const blocks : string[] = normalizedTranscript.split(/\n{2,}/);

  for (const block of blocks) {
    const lines : string[] = block
      .split('\n')
      .map((line : string) => line.trim())
      .filter((line : string) => line.length > 0);

    if (lines.length < 2) {
      continue;
    }

    const timeLineIndex : number = /^\d+$/.test(lines[0]) ? 1 : 0;
    const timeLine : string | undefined = lines[timeLineIndex];
    if (timeLine === undefined) {
      continue;
    }

    const timeMatch : RegExpMatchArray | null = timeLine.match(
      /(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3})/,
    );
    if (timeMatch === null) {
      continue;
    }

    const startSeconds : number | null = parseSrtTime(timeMatch[1]);
    const endSeconds : number | null = parseSrtTime(timeMatch[2]);
    if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds) {
      continue;
    }

    const textLines : string[] = lines.slice(timeLineIndex + 1);
    const text : string = textLines.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length === 0) {
      continue;
    }

    cues.push({ startSeconds, endSeconds, text });
  }

  return cues.sort((a : TranscriptCue, b : TranscriptCue) => a.startSeconds - b.startSeconds);
}

export function analyzeHighlightCandidates(params : {
  transcript : string;
  durationSeconds : number;
  mode : HighlightMode;
  learningProfile : HighlightLearningProfile;
  maxResults ?: number;
}) : HighlightCandidate[] {
  const cues : TranscriptCue[] = parseSrtCues(params.transcript);
  if (cues.length === 0) {
    return [];
  }

  const durationSeconds : number = Math.max(1, Math.round(params.durationSeconds));
  const maxResults : number = Math.max(1, params.maxResults ?? 8);
  const windowSize : number = resolveWindowSize(durationSeconds);
  const stepSize : number = Math.max(4, Math.round(windowSize * 0.4));

  const rawCandidates : HighlightCandidate[] = [];
  for (let windowStart : number = 0; windowStart < durationSeconds; windowStart += stepSize) {
    const windowEnd : number = Math.min(durationSeconds, windowStart + windowSize);
    if (windowEnd - windowStart < 4) {
      continue;
    }

    const overlapping : TranscriptCue[] = cues.filter((cue : TranscriptCue) => cue.endSeconds > windowStart && cue.startSeconds < windowEnd);
    if (overlapping.length === 0) {
      continue;
    }

    const mergedText : string = overlapping.map((cue : TranscriptCue) => cue.text).join(' ').replace(/\s+/g, ' ').trim();
    const words : string[] = tokenizeHungarianWords(mergedText);
    if (words.length < 5) {
      continue;
    }

    const features : Record<string, number> = computeWindowFeatures({
      words,
      text: mergedText,
      durationSeconds: Math.max(1, windowEnd - windowStart),
    });

    const evaluated : {
      score : number;
      reasons : HighlightFeatureReason[];
    } = scoreWindow(features, params.mode, params.learningProfile);

    if (evaluated.score <= 0.08) {
      continue;
    }

    const clipStart : number = Math.max(0, Math.min(windowStart, overlapping[0].startSeconds - 0.4));
    const clipEnd : number = Math.min(durationSeconds, Math.max(windowEnd, overlapping[overlapping.length - 1].endSeconds + 0.4));

    rawCandidates.push({
      startSeconds: roundSeconds(clipStart),
      endSeconds: roundSeconds(Math.max(clipStart + 2, clipEnd)),
      score: evaluated.score,
      transcriptSnippet: buildSnippet(mergedText),
      reasons: evaluated.reasons,
      reasonSummary: buildReasonSummary(evaluated.reasons),
    });
  }

  const uniqueCandidates : HighlightCandidate[] = dedupeCandidates(rawCandidates, durationSeconds);
  const sorted : HighlightCandidate[] = uniqueCandidates
    .sort((a : HighlightCandidate, b : HighlightCandidate) => b.score - a.score)
    .slice(0, maxResults);

  return sorted.map((candidate : HighlightCandidate) => ({
    ...candidate,
    score: Number(candidate.score.toFixed(4)),
  }));
}

export function sliceTranscriptForRange(transcript : string, startSeconds : number, endSeconds : number) : string {
  const cues : TranscriptCue[] = parseSrtCues(transcript);
  if (cues.length === 0) {
    return '';
  }

  const safeStart : number = Math.max(0, startSeconds);
  const safeEnd : number = Math.max(safeStart + 0.1, endSeconds);
  const selected : TranscriptCue[] = cues.filter((cue : TranscriptCue) => cue.endSeconds > safeStart && cue.startSeconds < safeEnd);

  const lines : string[] = [];
  let index : number = 1;
  for (const cue of selected) {
    const shiftedStart : number = Math.max(0, cue.startSeconds - safeStart);
    const shiftedEnd : number = Math.max(shiftedStart + 0.05, Math.min(safeEnd, cue.endSeconds) - safeStart);
    lines.push(String(index));
    lines.push(`${formatSrtTime(shiftedStart)} --> ${formatSrtTime(shiftedEnd)}`);
    lines.push(cue.text);
    lines.push('');
    index += 1;
  }

  return lines.join('\n').trim();
}

export async function loadHighlightLearningProfile(filePath : string) : Promise<HighlightLearningProfile> {
  try {
    const raw : string = await readFile(filePath, 'utf8');
    const parsed : unknown = JSON.parse(raw) as unknown;
    if (isLearningProfile(parsed) === true) {
      return parsed;
    }
  } catch {
    // Ha még nincs fájl vagy sérült, default profilt adunk vissza.
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    modes: {},
  };
}

export async function saveHighlightLearningProfile(filePath : string, profile : HighlightLearningProfile) : Promise<void> {
  const directoryPath : string = filePath.replace(/\/[^/]+$/, '');
  await mkdir(directoryPath, { recursive: true });
  await writeFile(filePath, JSON.stringify(profile, null, 2), 'utf8');
}

export function applyLearningFeedback(params : {
  profile : HighlightLearningProfile;
  mode : HighlightMode;
  reasons : HighlightFeatureReason[];
  isAccurate : boolean;
}) : HighlightLearningProfile {
  const next : HighlightLearningProfile = {
    version: params.profile.version,
    updatedAt: new Date().toISOString(),
    modes: {
      ...params.profile.modes,
    },
  };

  const modeStats : Record<string, HighlightLearningStat> = {
    ...(next.modes[params.mode] ?? {}),
  };

  for (const reason of params.reasons) {
    const current : HighlightLearningStat = modeStats[reason.key] ?? { correct: 0, incorrect: 0 };
    if (params.isAccurate === true) {
      current.correct += 1;
    } else {
      current.incorrect += 1;
    }
    modeStats[reason.key] = current;
  }

  next.modes[params.mode] = modeStats;
  return next;
}

function resolveWindowSize(durationSeconds : number) : number {
  if (durationSeconds >= 3600) {
    return 28;
  }
  if (durationSeconds >= 1800) {
    return 24;
  }
  if (durationSeconds >= 600) {
    return 20;
  }
  return 16;
}

function computeWindowFeatures(params : {
  words : string[];
  text : string;
  durationSeconds : number;
}) : Record<string, number> {
  const { words, text, durationSeconds } = params;
  const uniqueWords : Set<string> = new Set<string>(words.filter((word : string) => HUNGARIAN_STOPWORDS.has(word) === false));
  const exclamationCount : number = (text.match(/!/g) ?? []).length;
  const questionCount : number = (text.match(/\?/g) ?? []).length;
  const numberCount : number = (text.match(/\b\d+[\d,.]*\b/g) ?? []).length;

  const positiveHits : number = countKeywordHits(words, POSITIVE_KEYWORDS);
  const negativeHits : number = countKeywordHits(words, NEGATIVE_KEYWORDS);
  const sentimentIntensity : number = normalizeRange(Math.abs(positiveHits - negativeHits) + Math.min(positiveHits, negativeHits) * 0.5, 0, 6);

  return {
    speechDensity: normalizeRange(words.length / durationSeconds, 0, 4.2),
    punctuationEnergy: normalizeRange(exclamationCount * 1.2 + questionCount * 0.9, 0, 5),
    humorSignals: normalizeRange(countKeywordHits(words, HUMOR_KEYWORDS), 0, 4),
    emotionSignals: normalizeRange(countKeywordHits(words, EMOTION_KEYWORDS), 0, 5),
    informationSignals: normalizeRange(countKeywordHits(words, INFO_KEYWORDS), 0, 6),
    dynamicSignals: normalizeRange(countKeywordHits(words, DYNAMIC_KEYWORDS), 0, 6),
    sentimentIntensity,
    numberDensity: normalizeRange(numberCount / Math.max(1, durationSeconds / 10), 0, 2.4),
    lexicalNovelty: normalizeRange(uniqueWords.size / Math.max(1, words.length), 0.2, 0.9),
  };
}

function scoreWindow(
  features : Record<string, number>,
  mode : HighlightMode,
  learningProfile : HighlightLearningProfile,
) : { score : number; reasons : HighlightFeatureReason[] } {
  const weights : Record<string, number> = MODE_WEIGHTS[mode];
  const reasons : HighlightFeatureReason[] = [];

  let weightedSum : number = 0;
  let weightMagnitude : number = 0;

  for (const [key, rawWeight] of Object.entries(weights)) {
    const normalizedValue : number = clamp01(features[key] ?? 0);
    const learningFactor : number = getLearningFactor(learningProfile, mode, key);
    const adjustedWeight : number = rawWeight * learningFactor;
    const contribution : number = normalizedValue * adjustedWeight;

    weightedSum += contribution;
    weightMagnitude += Math.abs(adjustedWeight);

    reasons.push({
      key,
      label: FEATURE_LABELS[key] ?? key,
      value: Number((features[key] ?? 0).toFixed(4)),
      normalized: Number(normalizedValue.toFixed(4)),
      weight: Number(adjustedWeight.toFixed(4)),
      contribution: Number(contribution.toFixed(4)),
      explanation: buildFeatureExplanation(key, normalizedValue),
    });
  }

  const score : number = weightMagnitude > 0 ? clamp01(weightedSum / weightMagnitude) : 0;
  const sortedReasons : HighlightFeatureReason[] = reasons.sort(
    (a : HighlightFeatureReason, b : HighlightFeatureReason) => b.contribution - a.contribution,
  );

  return { score, reasons: sortedReasons };
}

function getLearningFactor(profile : HighlightLearningProfile, mode : HighlightMode, featureKey : string) : number {
  const modeStats : Record<string, HighlightLearningStat> | undefined = profile.modes[mode];
  if (modeStats === undefined) {
    return 1;
  }

  const stat : HighlightLearningStat | undefined = modeStats[featureKey];
  if (stat === undefined) {
    return 1;
  }

  const total : number = stat.correct + stat.incorrect;
  if (total <= 0) {
    return 1;
  }

  const confidence : number = Math.min(1, total / 10);
  const direction : number = (stat.correct - stat.incorrect) / total;
  return 1 + direction * confidence * 0.45;
}

function dedupeCandidates(candidates : HighlightCandidate[], durationSeconds : number) : HighlightCandidate[] {
  const sortedByScore : HighlightCandidate[] = [...candidates].sort((a : HighlightCandidate, b : HighlightCandidate) => b.score - a.score);
  const selected : HighlightCandidate[] = [];
  const maxAllowedOverlapSeconds : number = 1.1;
  const maxAllowedOverlapRatio : number = 0.12;

  for (const candidate of sortedByScore) {
    const overlapsExisting : boolean = selected.some((picked : HighlightCandidate) => {
      const intersectionSeconds : number = overlapSeconds(candidate, picked);
      if (intersectionSeconds <= 0) {
        return false;
      }

      if (intersectionSeconds > maxAllowedOverlapSeconds) {
        return true;
      }

      const unionRatio : number = overlapRatio(candidate, picked);
      const shorterRatio : number = overlapRatioToShorter(candidate, picked);
      return unionRatio > maxAllowedOverlapRatio || shorterRatio > maxAllowedOverlapRatio;
    });
    if (overlapsExisting === true) {
      continue;
    }

    selected.push({
      ...candidate,
      startSeconds: clampRange(candidate.startSeconds, 0, durationSeconds),
      endSeconds: clampRange(candidate.endSeconds, 0, durationSeconds),
    });

    if (selected.length >= 12) {
      break;
    }
  }

  return selected;
}

function overlapSeconds(a : HighlightCandidate, b : HighlightCandidate) : number {
  const start : number = Math.max(a.startSeconds, b.startSeconds);
  const end : number = Math.min(a.endSeconds, b.endSeconds);
  return Math.max(0, end - start);
}

function overlapRatio(a : HighlightCandidate, b : HighlightCandidate) : number {
  const intersection : number = overlapSeconds(a, b);
  const union : number = Math.max(0.001, Math.max(a.endSeconds, b.endSeconds) - Math.min(a.startSeconds, b.startSeconds));
  return intersection / union;
}

function overlapRatioToShorter(a : HighlightCandidate, b : HighlightCandidate) : number {
  const intersection : number = overlapSeconds(a, b);
  const shorterDuration : number = Math.max(0.001, Math.min(a.endSeconds - a.startSeconds, b.endSeconds - b.startSeconds));
  return intersection / shorterDuration;
}

function buildSnippet(text : string) : string {
  const compact : string = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= 220) {
    return compact;
  }
  return `${compact.slice(0, 217)}...`;
}

function buildReasonSummary(reasons : HighlightFeatureReason[]) : string {
  const topReasons : HighlightFeatureReason[] = reasons
    .filter((reason : HighlightFeatureReason) => reason.contribution > 0.06)
    .slice(0, 3);

  if (topReasons.length === 0) {
    return 'Atlagos, de stabil jelzeseket mutatott.';
  }

  return topReasons.map((reason : HighlightFeatureReason) => `${reason.label}: ${Math.round(reason.normalized * 100)}%`).join(' | ');
}

function buildFeatureExplanation(key : string, normalizedValue : number) : string {
  const percent : number = Math.round(normalizedValue * 100);
  if (key === 'speechDensity') {
    return `A szoveg tempaja ${percent}% erossegu volt az adott ablakban.`;
  }
  if (key === 'punctuationEnergy') {
    return `Felkialto/kerdo jelek intenzitasa ${percent}%.`;
  }
  if (key === 'humorSignals') {
    return `Humorra utalo mintak erossege ${percent}%.`;
  }
  if (key === 'emotionSignals') {
    return `Erzelmi kulcsszavak jelenlete ${percent}%.`;
  }
  if (key === 'informationSignals') {
    return `Informativ kulcsszavak aranya ${percent}%.`;
  }
  if (key === 'dynamicSignals') {
    return `Dinamikus kifejezesek aranya ${percent}%.`;
  }
  if (key === 'sentimentIntensity') {
    return `Erzelmi toltet intenzitasa ${percent}%.`;
  }
  if (key === 'numberDensity') {
    return `Szam/adat suruseg ${percent}%.`;
  }
  if (key === 'lexicalNovelty') {
    return `Szohasznalat valtozatossaga ${percent}%.`;
  }
  return `Feature erosseg: ${percent}%.`;
}

function countKeywordHits(words : string[], keywords : readonly string[]) : number {
  if (words.length === 0 || keywords.length === 0) {
    return 0;
  }

  let hits : number = 0;
  for (const word of words) {
    for (const keyword of keywords) {
      if (word.includes(keyword)) {
        hits += 1;
        break;
      }
    }
  }

  return hits;
}

function tokenizeHungarianWords(text : string) : string[] {
  const normalized : string = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized.length === 0) {
    return [];
  }

  return normalized.split(' ').filter((word : string) => word.length > 0);
}

function parseSrtTime(raw : string) : number | null {
  const match : RegExpMatchArray | null = raw.match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (match === null) {
    return null;
  }

  const hours : number = Number(match[1]);
  const minutes : number = Number(match[2]);
  const seconds : number = Number(match[3]);
  const millis : number = Number(match[4].padEnd(3, '0'));

  if ([hours, minutes, seconds, millis].some((value : number) => Number.isFinite(value) === false)) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function formatSrtTime(totalSeconds : number) : string {
  const safeSeconds : number = Math.max(0, totalSeconds);
  const hours : number = Math.floor(safeSeconds / 3600);
  const minutes : number = Math.floor((safeSeconds % 3600) / 60);
  const seconds : number = Math.floor(safeSeconds % 60);
  const millis : number = Math.round((safeSeconds - Math.floor(safeSeconds)) * 1000);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function normalizeRange(value : number, min : number, max : number) : number {
  if (max <= min) {
    return 0;
  }
  return clamp01((value - min) / (max - min));
}

function clamp01(value : number) : number {
  return Math.max(0, Math.min(1, value));
}

function clampRange(value : number, min : number, max : number) : number {
  return Math.max(min, Math.min(max, value));
}

function roundSeconds(value : number) : number {
  return Number(value.toFixed(3));
}

function isLearningProfile(value : unknown) : value is HighlightLearningProfile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate : Record<string, unknown> = value as Record<string, unknown>;
  if (typeof candidate['version'] !== 'number') {
    return false;
  }
  if (typeof candidate['updatedAt'] !== 'string') {
    return false;
  }
  if (typeof candidate['modes'] !== 'object' || candidate['modes'] === null) {
    return false;
  }
  return true;
}
