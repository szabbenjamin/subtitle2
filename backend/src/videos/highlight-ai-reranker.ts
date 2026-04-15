import { spawn } from 'child_process';
import { access, constants } from 'fs/promises';
import { HighlightCandidate, HighlightFeatureReason, HighlightMode } from './video-highlights.pipeline';

export interface LocalAiRerankOptions {
  enabled : boolean;
  pythonCommand : string;
  scriptPath : string;
  timeoutMs : number;
  aiBlend : number;
  modelName : string;
}

interface LocalAiRerankScriptResponse {
  scores : number[];
  explanations ?: string[];
  model ?: string;
}

export interface LocalAiRerankResult {
  used : boolean;
  details : string;
  candidates : HighlightCandidate[];
}

export async function rerankHighlightCandidatesWithLocalAi(params : {
  candidates : HighlightCandidate[];
  mode : HighlightMode;
  options : LocalAiRerankOptions;
}) : Promise<LocalAiRerankResult> {
  const { candidates, mode, options } = params;
  if (options.enabled === false) {
    return {
      used: false,
      details: 'HIGHLIGHT_AI_ENABLED=false',
      candidates,
    };
  }

  if (candidates.length === 0) {
    return {
      used: false,
      details: 'Nincs ujrapontozhato jelolt.',
      candidates,
    };
  }

  if (options.scriptPath.trim().length === 0) {
    return {
      used: false,
      details: 'Nincs beallitva HIGHLIGHT_AI_SCRIPT_PATH.',
      candidates,
    };
  }

  try {
    await access(options.scriptPath, constants.R_OK);
  } catch {
    return {
      used: false,
      details: `AI script nem olvashato: ${options.scriptPath}`,
      candidates,
    };
  }

  let response : LocalAiRerankScriptResponse;
  try {
    response = await runLocalAiRerankScript({
      options,
      mode,
      texts: candidates.map((candidate : HighlightCandidate) => candidate.transcriptSnippet),
    });
  } catch (error : unknown) {
    const message : string = error instanceof Error ? error.message : 'ismeretlen script hiba';
    return {
      used: false,
      details: `AI script hiba: ${message}`,
      candidates,
    };
  }

  if (response.scores.length !== candidates.length) {
    return {
      used: false,
      details: `AI score darabszam elteres. vart=${candidates.length}, kapott=${response.scores.length}`,
      candidates,
    };
  }

  const aiBlend : number = clampRange(options.aiBlend, 0, 1);
  const ruleBlend : number = clampRange(1 - aiBlend, 0, 1);
  const reranked : HighlightCandidate[] = candidates
    .map((candidate : HighlightCandidate, index : number) => {
      const ruleScore : number = clampRange(candidate.score, 0, 1);
      const aiScore : number = clampRange(response.scores[index], 0, 1);
      const finalScore : number = clampRange(ruleScore * ruleBlend + aiScore * aiBlend, 0, 1);
      const explanation : string = response.explanations?.[index] ?? `Lokalis AI mod score: ${Math.round(aiScore * 100)}%.`;

      const adjustedReasons : HighlightFeatureReason[] = candidate.reasons.map((reason : HighlightFeatureReason) => ({
        ...reason,
        weight: Number((reason.weight * ruleBlend).toFixed(4)),
        contribution: Number((reason.contribution * ruleBlend).toFixed(4)),
      }));

      const semanticReason : HighlightFeatureReason = {
        key: 'semanticModeMatch',
        label: 'AI szemantikus illeszkedes',
        value: Number(aiScore.toFixed(4)),
        normalized: Number(aiScore.toFixed(4)),
        weight: Number(aiBlend.toFixed(4)),
        contribution: Number((aiScore * aiBlend).toFixed(4)),
        explanation,
      };

      const reasons : HighlightFeatureReason[] = [...adjustedReasons, semanticReason].sort(
        (a : HighlightFeatureReason, b : HighlightFeatureReason) => b.contribution - a.contribution,
      );

      return {
        ...candidate,
        score: Number(finalScore.toFixed(4)),
        reasons,
        reasonSummary: buildReasonSummaryFromReasons(reasons, candidate.reasonSummary),
      };
    })
    .sort((a : HighlightCandidate, b : HighlightCandidate) => b.score - a.score);

  return {
    used: true,
    details: `model=${response.model ?? options.modelName}, blend=${aiBlend}`,
    candidates: reranked,
  };
}

async function runLocalAiRerankScript(params : {
  options : LocalAiRerankOptions;
  mode : HighlightMode;
  texts : string[];
}) : Promise<LocalAiRerankScriptResponse> {
  const { options, mode, texts } = params;
  const payload : string = JSON.stringify({
    mode,
    texts,
  });

  return await new Promise<LocalAiRerankScriptResponse>((resolve, reject) => {
    const child = spawn(options.pythonCommand, [options.scriptPath], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HIGHLIGHT_AI_MODEL: options.modelName,
      },
    });

    let stdout : string = '';
    let stderr : string = '';
    const timeoutId : ReturnType<typeof setTimeout> = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timeout (${options.timeoutMs} ms)`));
    }, Math.max(1000, options.timeoutMs));

    child.stdout.on('data', (chunk : Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk : Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error : Error) => {
      clearTimeout(timeoutId);
      reject(error);
    });

    child.on('close', (code : number | null) => {
      clearTimeout(timeoutId);
      if (code !== 0) {
        reject(new Error(`exitCode=${String(code)} stderr=${stderr.trim()}`));
        return;
      }

      const trimmed : string = stdout.trim();
      if (trimmed.length === 0) {
        reject(new Error('ures AI script kimenet'));
        return;
      }

      let parsed : unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch (error : unknown) {
        const errorMessage : string = error instanceof Error ? error.message : 'ismeretlen JSON parse hiba';
        reject(new Error(`JSON parse hiba: ${errorMessage}. Raw: ${trimmed.slice(0, 200)}`));
        return;
      }

      if (isValidLocalAiResponse(parsed) === false) {
        reject(new Error(`ervenytelen AI script valasz. Raw: ${trimmed.slice(0, 200)}`));
        return;
      }

      resolve(parsed);
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

function isValidLocalAiResponse(value : unknown) : value is LocalAiRerankScriptResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record : Record<string, unknown> = value as Record<string, unknown>;
  if (Array.isArray(record['scores']) === false) {
    return false;
  }
  if (
    (record['scores'] as unknown[]).some((entry : unknown) => typeof entry !== 'number' || Number.isFinite(entry) === false)
  ) {
    return false;
  }

  if (record['explanations'] !== undefined) {
    if (Array.isArray(record['explanations']) === false) {
      return false;
    }
    if ((record['explanations'] as unknown[]).some((entry : unknown) => typeof entry !== 'string')) {
      return false;
    }
  }

  if (record['model'] !== undefined && typeof record['model'] !== 'string') {
    return false;
  }

  return true;
}

function buildReasonSummaryFromReasons(reasons : HighlightFeatureReason[], fallback : string) : string {
  const top : HighlightFeatureReason[] = reasons.filter((reason : HighlightFeatureReason) => reason.contribution > 0.04).slice(0, 3);
  if (top.length === 0) {
    return fallback;
  }
  return top.map((reason : HighlightFeatureReason) => `${reason.label}: ${Math.round(reason.normalized * 100)}%`).join(' | ');
}

function clampRange(value : number, min : number, max : number) : number {
  if (Number.isFinite(value) === false) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}
