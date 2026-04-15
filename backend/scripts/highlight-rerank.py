#!/usr/bin/env python3
"""Local semantic reranker for highlight candidate texts.

Input (stdin JSON):
{
  "mode": "funny",
  "texts": ["...", "..."]
}

Output (stdout JSON):
{
  "scores": [0.73, 0.41],
  "explanations": ["...", "..."],
  "model": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
}
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Sequence, Tuple

import numpy as np
from fastembed import TextEmbedding

MODE_PROTOTYPES: Dict[str, List[str]] = {
    "balanced": [
        "Jol kiegyensulyozott jelenet eros beszedtempoval es ertelmes mondanivaloval.",
        "Tartalmas es figyelemfelkelto pillanat, ami tobb nezonek erdekes lehet.",
        "Stabil ritmusu, atfogo, jo minosegu reszlet.",
    ],
    "funny": [
        "Humoros, poenos vagy nevetest kivaltani kepes jelenet.",
        "Varatlan, ironikus vagy komikus megszolalas.",
        "Konnyed, szorakoztato, vicces momentum.",
    ],
    "emotional": [
        "Erzelmileg eros, meghato vagy feszult pillanat.",
        "Szemelyes, oszinte, erzelmekkel teli megszolalas.",
        "Nagy erzelmi toltetu jelenet, ami hatast kelt.",
    ],
    "informative": [
        "Informativ reszlet tenyadatokkal, tippekkel vagy gyakorlatias tanaccsal.",
        "Oktato jellegu, lenyegi magyarazatot ado jelenet.",
        "Hasznos, konkret informaciot kozlo pillanat.",
    ],
    "dynamic": [
        "Porgos, energikus, dinamikus jelenet eros tempoval.",
        "Gyors valtasokkal vagy intenziv hangulattal teli reszlet.",
        "Akciozus, mozgalmas, lenduletes pillanat.",
    ],
}


def clamp01(value: float) -> float:
    if not np.isfinite(value):
        return 0.0
    return float(max(0.0, min(1.0, value)))


def parse_stdin_payload() -> Tuple[str, List[str]]:
    raw: str = sys.stdin.read().strip()
    if raw == "":
        raise ValueError("Empty input payload.")

    payload: Any = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("Payload must be a JSON object.")

    mode_value: Any = payload.get("mode")
    texts_value: Any = payload.get("texts")

    if not isinstance(mode_value, str):
        raise ValueError("Payload.mode must be a string.")
    if not isinstance(texts_value, list):
        raise ValueError("Payload.texts must be an array.")

    texts: List[str] = []
    for item in texts_value:
        if not isinstance(item, str):
            raise ValueError("Each text must be a string.")
        compact: str = " ".join(item.split()).strip()
        if len(compact) > 1800:
            compact = compact[:1800]
        texts.append(compact)

    return mode_value.strip().lower(), texts


def embed_texts(
    model_name: str,
    candidate_texts: Sequence[str],
    prototype_texts: Sequence[str],
) -> Tuple[np.ndarray, np.ndarray]:
    embedder = TextEmbedding(model_name=model_name)
    query_inputs: List[str] = [f"query: {text}" for text in candidate_texts]
    passage_inputs: List[str] = [f"passage: {text}" for text in prototype_texts]
    vectors: List[np.ndarray] = [np.asarray(item, dtype=np.float32) for item in embedder.embed(query_inputs + passage_inputs)]

    candidate_count: int = len(candidate_texts)
    if len(vectors) != candidate_count + len(prototype_texts):
        raise RuntimeError("Unexpected embedding result count.")

    candidate_vectors: np.ndarray = np.stack(vectors[:candidate_count], axis=0)
    prototype_vectors: np.ndarray = np.stack(vectors[candidate_count:], axis=0)
    return candidate_vectors, prototype_vectors


def semantic_scores(candidate_vectors: np.ndarray, prototype_vectors: np.ndarray) -> Tuple[List[float], List[int]]:
    candidate_norms: np.ndarray = np.linalg.norm(candidate_vectors, axis=1)
    prototype_norms: np.ndarray = np.linalg.norm(prototype_vectors, axis=1)

    denominator: np.ndarray = np.outer(candidate_norms, prototype_norms) + 1e-9
    similarity_matrix: np.ndarray = np.matmul(candidate_vectors, prototype_vectors.T) / denominator

    best_indices: np.ndarray = np.argmax(similarity_matrix, axis=1)
    best_values: np.ndarray = similarity_matrix[np.arange(similarity_matrix.shape[0]), best_indices]

    scores: List[float] = [clamp01((float(value) + 1.0) / 2.0) for value in best_values]
    indices: List[int] = [int(index) for index in best_indices]
    return scores, indices


def main() -> int:
    mode, texts = parse_stdin_payload()
    if len(texts) == 0:
        print(json.dumps({"scores": [], "explanations": [], "model": ""}))
        return 0

    prototypes: List[str] = MODE_PROTOTYPES.get(mode, MODE_PROTOTYPES["balanced"])
    model_name: str = os.environ.get("HIGHLIGHT_AI_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2").strip() or "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

    candidate_vectors, prototype_vectors = embed_texts(model_name, texts, prototypes)
    scores, best_indices = semantic_scores(candidate_vectors, prototype_vectors)

    explanations: List[str] = []
    for score, proto_idx in zip(scores, best_indices):
        proto_text: str = prototypes[proto_idx]
        explanations.append(
            f"Lokalis AI szerint ez a jelenet leginkabb ehhez illeszkedik: \"{proto_text}\" ({round(score * 100)}%)."
        )

    output: Dict[str, Any] = {
        "scores": [round(score, 4) for score in scores],
        "explanations": explanations,
        "model": model_name,
    }
    print(json.dumps(output, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # pragma: no cover - worker oldali fallback kezeli
        print(f"highlight-rerank.py error: {error}", file=sys.stderr)
        raise SystemExit(1)
