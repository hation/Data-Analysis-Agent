# -*- coding: utf-8 -*-
"""
neural_embedder — BGE-small-zh neural embedding via torch (no transformers).

Loads BAAI/bge-small-zh-v1.5 (4-layer BERT, 512-dim, ~91MB) directly with
torch + tokenizers, bypassing the transformers dependency that requires
stdlib modules (profile, pydoc, pickletools) missing in Box's portable Python.

Provides:
  - embed(text) -> list[float]      : single text -> 512-dim normalized vector
  - embed_batch(texts) -> list      : batched encoding for efficiency
  - cosine(a, b) -> float           : cosine similarity (vectors are pre-normalized)

Falls back to hash-projection embedding if torch is unavailable or model
files are missing, ensuring the system always works.
"""
from __future__ import annotations

import json
import logging
import math
import os
import pathlib
import urllib.request
from typing import Sequence
from urllib.parse import urlsplit

from infrastructure.paths import runtime_config_path

log = logging.getLogger(__name__)

# ── Model path resolution ────────────────────────────────────────────────────

_CACHE_DIR = pathlib.Path(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
) / "baa_models" / "models--BAAI--bge-small-zh-v1.5" / "snapshots"

_MODEL_DIR: pathlib.Path | None = None
if _CACHE_DIR.exists():
    _dirs = [d for d in _CACHE_DIR.iterdir() if d.is_dir()]
    if _dirs:
        _MODEL_DIR = _dirs[0]

# ── Config ───────────────────────────────────────────────────────────────────

_EMBED_DIM = 512
_MAX_LEN = 128  # max token length for encoding

# -- Cloud embedding (Orange Pi BGE-large-zh via Cloudflare Tunnel) ----------
_EMBED_CONFIG_FILE = runtime_config_path(
    "embedding_config.json", "LLM/embedding_config.json"
)


def _load_saved_config() -> dict:
    try:
        data = json.loads(_EMBED_CONFIG_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


_SAVED_CONFIG = _load_saved_config()
_CLOUD_URL = (
    os.environ.get("BAA_CLOUD_EMBED_URL")
    or _SAVED_CONFIG.get("cloud_url")
    or "https://embed.zafer-liu-product.xyz"
).strip()
_CLOUD_TOKEN = (
    os.environ.get("BAA_CLOUD_EMBED_TOKEN")
    or _SAVED_CONFIG.get("cloud_token")
    or ""
).strip()
_CLOUD_MODEL = (
    os.environ.get("BAA_CLOUD_EMBED_MODEL")
    or _SAVED_CONFIG.get("cloud_model")
    or "bge-large-zh"
).strip()
_CLOUD_DIM = 1024
_CLOUD_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
_CLOUD_TIMEOUT = 30
_cloud_available = None  # None=untested, True/False
_query_embedding_cache: dict[tuple[str, str], list[float]] = {}

# -- Embedding mode override (auto / cloud / local / hash) -------------------
_embed_mode = (
    os.environ.get("BAA_EMBED_MODE")
    or _SAVED_CONFIG.get("mode")
    or "auto"
).strip().lower()
if _embed_mode not in {"auto", "cloud", "local", "hash"}:
    _embed_mode = "auto"


_model = None
_tokenizer = None
_use_neural = False
_init_attempted = False
_init_error = ""


def _init_neural():
    """Lazy-init torch model + tokenizer. Returns True on success."""
    global _model, _tokenizer, _use_neural, _init_attempted
    if _init_attempted:
        return _use_neural
    _init_attempted = True

    if _MODEL_DIR is None or not (_MODEL_DIR / "pytorch_model.bin").exists():
        log.info("[neural_embedder] model files not found, using hash fallback")
        return False

    try:
        import torch
        import torch.nn as nn
        import torch.nn.functional as F
        from tokenizers import Tokenizer

        config = json.loads((_MODEL_DIR / "config.json").read_text(encoding="utf-8"))
        hid = config["hidden_size"]
        n_layers = config["num_hidden_layers"]
        n_heads = config["num_attention_heads"]
        vocab = config["vocab_size"]
        max_pos = config["max_position_embeddings"]
        intermediate = config.get("intermediate_size", 3072)

        head_dim = hid // n_heads

        class BertEmbeddings(nn.Module):
            def __init__(self):
                super().__init__()
                self.word = nn.Embedding(vocab, hid, padding_idx=0)
                self.pos = nn.Embedding(max_pos, hid)
                self.tok_type = nn.Embedding(2, hid)
                self.ln = nn.LayerNorm(hid)
                self.register_buffer(
                    "pos_ids", torch.arange(max_pos).unsqueeze(0)
                )

            def forward(self, ids):
                pos = self.pos_ids[:, : ids.size(1)]
                x = (
                    self.word(ids)
                    + self.pos(pos)
                    + self.tok_type(torch.zeros_like(ids))
                )
                return self.ln(x)

        class BertLayer(nn.Module):
            def __init__(self):
                super().__init__()
                self.q = nn.Linear(hid, hid)
                self.k = nn.Linear(hid, hid)
                self.v = nn.Linear(hid, hid)
                self.attn_out = nn.Linear(hid, hid)
                self.attn_ln = nn.LayerNorm(hid)
                self.ffn1 = nn.Linear(hid, intermediate)
                self.ffn2 = nn.Linear(intermediate, hid)
                self.ffn_ln = nn.LayerNorm(hid)

            def forward(self, x, mask):
                B, L, H = x.shape
                q = self.q(x).view(B, L, n_heads, head_dim).transpose(1, 2)
                k = self.k(x).view(B, L, n_heads, head_dim).transpose(1, 2)
                v = self.v(x).view(B, L, n_heads, head_dim).transpose(1, 2)
                scores = torch.matmul(q, k.transpose(-1, -2)) / math.sqrt(head_dim)
                ext = (1.0 - mask.float().unsqueeze(1).unsqueeze(2)) * -10000.0
                scores = scores + ext
                attn = F.softmax(scores, dim=-1)
                ctx = (
                    torch.matmul(attn, v)
                    .transpose(1, 2)
                    .contiguous()
                    .view(B, L, H)
                )
                x = self.attn_ln(x + self.attn_out(ctx))
                ffn = self.ffn2(F.gelu(self.ffn1(x)))
                return self.ffn_ln(x + ffn)

        class MiniBGE(nn.Module):
            def __init__(self):
                super().__init__()
                self.embeddings = BertEmbeddings()
                self.layers = nn.ModuleList(
                    [BertLayer() for _ in range(n_layers)]
                )

            def forward(self, ids, mask):
                x = self.embeddings(ids)
                for layer in self.layers:
                    x = layer(x, mask)
                return x

        model = MiniBGE()
        state = torch.load(
            str(_MODEL_DIR / "pytorch_model.bin"),
            map_location="cpu",
            weights_only=True,
        )
        new_state = {}
        for k, v in state.items():
            nk = k
            nk = nk.replace("embeddings.word_embeddings", "embeddings.word")
            nk = nk.replace("embeddings.position_embeddings", "embeddings.pos")
            nk = nk.replace("embeddings.token_type_embeddings", "embeddings.tok_type")
            nk = nk.replace("embeddings.LayerNorm", "embeddings.ln")
            nk = nk.replace("encoder.layer.", "layers.")
            nk = nk.replace(".attention.self.query.", ".q.")
            nk = nk.replace(".attention.self.key.", ".k.")
            nk = nk.replace(".attention.self.value.", ".v.")
            nk = nk.replace(".attention.output.dense", ".attn_out")
            nk = nk.replace(".attention.output.LayerNorm", ".attn_ln")
            nk = nk.replace(".intermediate.dense", ".ffn1")
            nk = nk.replace(".output.dense", ".ffn2")
            nk = nk.replace(".output.LayerNorm", ".ffn_ln")
            new_state[nk] = v
        model.load_state_dict(new_state, strict=False)
        model.eval()
        _model = model

        tok = Tokenizer.from_file(str(_MODEL_DIR / "tokenizer.json"))
        tok.enable_padding(length=_MAX_LEN)
        tok.enable_truncation(max_length=_MAX_LEN)
        _tokenizer = tok

        _use_neural = True
        log.info("[neural_embedder] BGE-small-zh loaded (dim=%d, layers=%d)", hid, n_layers)
    except Exception as e:
        global _init_error
        _init_error = str(e)
        log.warning("[neural_embedder] init failed (%s), using hash fallback", e)
        _use_neural = False
    return _use_neural


# ── Public API ───────────────────────────────────────────────────────────────


def _cloud_is_candidate() -> bool:
    return bool(_CLOUD_TOKEN and _CLOUD_URL) and _cloud_available is not False


def _try_cloud_batch(texts: Sequence[str]) -> list[list[float]] | None:
    global _cloud_available
    if not _cloud_is_candidate():
        return None
    try:
        vectors = _cloud_embed_batch(texts)
        if len(vectors) != len(texts) or any(len(vector) != _CLOUD_DIM for vector in vectors):
            raise ValueError("cloud embedding response dimension mismatch")
        _cloud_available = True
        dim = len(vectors[0]) if vectors else 0
        log.info(
            "[neural_embedder] embed backend=cloud mode=%s model=%s endpoint=%s count=%d dim=%d",
            _embed_mode,
            _CLOUD_MODEL,
            urlsplit(_CLOUD_URL).netloc,
            len(texts),
            dim,
        )
        return vectors
    except Exception as exc:
        _cloud_available = False
        log.info("[neural_embedder] cloud unavailable (%s), falling back", exc)
        return None
def embed(text: str) -> list[float]:
    """Embed one text without a separate cloud probe request."""
    if _embed_mode in ("auto", "cloud"):
        vectors = _try_cloud_batch([text])
        if vectors is not None:
            return vectors[0]
    if _embed_mode in ("auto", "local") and _init_neural():
        vector = _neural_embed(text)
        log.info(
            "[neural_embedder] embed backend=local mode=%s model=%s count=1 dim=%d",
            _embed_mode,
            "BGE-small-zh-v1.5",
            len(vector),
        )
        return vector
    vector = _hash_embed(text)
    log.info(
        "[neural_embedder] embed backend=hash mode=%s model=%s count=1 dim=%d",
        _embed_mode,
        "Hash projection",
        len(vector),
    )
    return vector
def embed_batch(texts: Sequence[str]) -> list[list[float]]:
    """Embed multiple texts in one cloud or local batch."""
    if not texts:
        return []
    if _embed_mode in ("auto", "cloud"):
        vectors = _try_cloud_batch(texts)
        if vectors is not None:
            return vectors
    if _embed_mode in ("auto", "local") and _init_neural():
        vectors = _neural_embed_batch(texts)
        dim = len(vectors[0]) if vectors else 0
        log.info(
            "[neural_embedder] embed backend=local mode=%s model=%s count=%d dim=%d",
            _embed_mode,
            "BGE-small-zh-v1.5",
            len(texts),
            dim,
        )
        return vectors
    vectors = [_hash_embed(text) for text in texts]
    dim = len(vectors[0]) if vectors else 0
    log.info(
        "[neural_embedder] embed backend=hash mode=%s model=%s count=%d dim=%d",
        _embed_mode,
        "Hash projection",
        len(texts),
        dim,
    )
    return vectors
def get_embedding_signature() -> str:
    """Identify the active backend/model/dimension for cache invalidation."""
    info = get_embed_info()
    return f"{info['active']}:{info['model']}:{info['dim']}"


def embed_query(text: str) -> list[float]:
    """Embed a user query once per active model and reuse it across retrievers."""
    normalized = str(text or "").strip()
    key = (
        get_embedding_signature(),
        hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
    )
    cached = _query_embedding_cache.get(key)
    if cached is not None:
        return cached
    vector = embed(normalized)
    if len(_query_embedding_cache) >= 128:
        _query_embedding_cache.pop(next(iter(_query_embedding_cache)))
    _query_embedding_cache[key] = vector
    return vector

def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    return sum(x * y for x, y in zip(a, b))


def is_neural() -> bool:
    """Whether a neural backend is selected or active."""
    if _embed_mode in ("auto", "cloud") and _cloud_is_candidate():
        return True
    if _embed_mode == "cloud":
        return False
    _init_neural()
    return _use_neural

def get_init_error() -> str:
    """Return the last init error string (empty if none)."""
    _init_neural()
    return _init_error


def set_embed_mode(mode: str) -> str:
    """Set the embedding mode at runtime.

    Valid values: auto, cloud, local, hash.
    Returns the normalized mode that was set.
    """
    global _embed_mode, _cloud_available
    m = (mode or "auto").strip().lower()
    if m not in ("auto", "cloud", "local", "hash"):
        m = "auto"
    _embed_mode = m
    _cloud_available = None  # force re-probe
    _query_embedding_cache.clear()
    _save_runtime_config()
    return _embed_mode


def _save_runtime_config() -> None:
    _EMBED_CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "mode": _embed_mode,
        "cloud_url": _CLOUD_URL,
        "cloud_token": _CLOUD_TOKEN,
        "cloud_model": _CLOUD_MODEL,
    }
    temp = _EMBED_CONFIG_FILE.with_suffix(".tmp")
    temp.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temp.replace(_EMBED_CONFIG_FILE)


def get_cloud_config() -> dict:
    return {
        "url": _CLOUD_URL,
        "model": _CLOUD_MODEL,
        "token_configured": bool(_CLOUD_TOKEN),
    }


def configure_cloud(
    *,
    url: str,
    model: str,
    token: str | None = None,
    clear_token: bool = False,
    verify: bool = False,
) -> dict:
    global _CLOUD_URL, _CLOUD_MODEL, _CLOUD_TOKEN, _cloud_available
    normalized_url = str(url or "").strip().rstrip("/")
    parsed = urlsplit(normalized_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("云端 URL 必须是有效的 http/https 地址")
    normalized_model = str(model or "").strip()
    if not normalized_model:
        raise ValueError("云端模型名不能为空")
    previous = (_CLOUD_URL, _CLOUD_MODEL, _CLOUD_TOKEN, _cloud_available)
    try:
        _CLOUD_URL = normalized_url
        _CLOUD_MODEL = normalized_model
        if clear_token:
            _CLOUD_TOKEN = ""
        elif token is not None and str(token).strip():
            _CLOUD_TOKEN = str(token).strip()
        _cloud_available = None
        _query_embedding_cache.clear()
        tested = test_cloud_connection() if verify else None
        _save_runtime_config()
        result = get_cloud_config()
        if tested is not None:
            result["test"] = tested
        return result
    except Exception:
        _CLOUD_URL, _CLOUD_MODEL, _CLOUD_TOKEN, _cloud_available = previous
        raise


def test_cloud_connection() -> dict:
    global _cloud_available
    if not _CLOUD_TOKEN:
        raise ValueError("请先配置 Bearer Token")
    vectors = _cloud_embed_batch(["连接测试"])
    if not vectors or len(vectors[0]) != _CLOUD_DIM:
        actual = len(vectors[0]) if vectors else 0
        raise ValueError(f"云端向量维度异常：期望 {_CLOUD_DIM}，实际 {actual}")
    _cloud_available = True
    return {"available": True, "dim": len(vectors[0]), "model": _CLOUD_MODEL}


def get_embed_info() -> dict:
    """Return current embedding status info for the UI."""
    cloud_selected = (
        _embed_mode in ("auto", "cloud")
        and bool(_CLOUD_TOKEN and _CLOUD_URL)
        and _cloud_available is not False
    )
    cloud_ok = _cloud_available is True
    local_ok = _init_neural() if _embed_mode in ("auto", "local") and not cloud_selected else False
    if cloud_selected:
        active = "cloud"
        dim = _CLOUD_DIM
        model = "BGE-large-zh (cloud)"
    elif local_ok:
        active = "local"
        dim = _EMBED_DIM
        model = "BGE-small-zh-v1.5 (local)"
    else:
        active = "hash"
        dim = 384
        model = "Hash projection"
    return {
        "mode": _embed_mode,
        "active": active,
        "dim": dim,
        "model": model,
        "cloud_url": _CLOUD_URL if _CLOUD_TOKEN else "",
        "cloud_available": cloud_ok,
        "cloud_configured": bool(_CLOUD_TOKEN and _CLOUD_URL),
        "cloud_status": (
            "available" if cloud_ok
            else "configured" if bool(_CLOUD_TOKEN and _CLOUD_URL) and _cloud_available is None
            else "unavailable"
        ),
        "local_available": bool(_MODEL_DIR and (_MODEL_DIR / "pytorch_model.bin").exists()),
    }


def reset_for_newly_installed_model():
    """Allow re-init after model files are downloaded at runtime.

    The module-level _MODEL_DIR is resolved once at import time. If the model
    was absent at import, callers that later download the files can invoke
    this to clear the cached init state so _init_neural() retries.
    """
    global _MODEL_DIR, _model, _tokenizer, _use_neural, _init_attempted
    if _CACHE_DIR.exists():
        _dirs = [d for d in _CACHE_DIR.iterdir() if d.is_dir()]
        if _dirs:
            _MODEL_DIR = _dirs[0]
    _model = None
    _tokenizer = None
    _use_neural = False
    _init_attempted = False
    _query_embedding_cache.clear()


# -- Cloud embedding implementation ------------------------------------------


def _cloud_embed_batch(texts):
    """Call Orange Pi cloud BGE-large-zh API. Returns 1024-dim vectors."""
    body = json.dumps(
        {"input": list(texts), "model": _CLOUD_MODEL}
    ).encode("utf-8")
    req = urllib.request.Request(
        _CLOUD_URL.rstrip("/") + "/v1/embeddings",
        method="POST",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + _CLOUD_TOKEN,
            "User-Agent": _CLOUD_UA,
        },
    )
    resp = urllib.request.urlopen(req, timeout=_CLOUD_TIMEOUT)
    data = json.loads(resp.read().decode("utf-8"))
    return [d["embedding"] for d in data["data"]]


def _cloud_probe():
    """Quick connectivity test for cloud endpoint."""
    global _cloud_available
    if _cloud_available is not None:
        return _cloud_available
    if not _CLOUD_TOKEN or not _CLOUD_URL:
        _cloud_available = False
        return False
    try:
        result = _cloud_embed_batch(["ping"])
        _cloud_available = len(result) > 0 and len(result[0]) == _CLOUD_DIM
        if _cloud_available:
            log.info("[neural_embedder] cloud BGE-large-zh active (dim=%d)", _CLOUD_DIM)
        return _cloud_available
    except Exception as e:
        log.info("[neural_embedder] cloud unavailable (%s), falling back to local", e)
        _cloud_available = False
        return False

# ── Neural implementation ────────────────────────────────────────────────────


def _neural_embed(text: str) -> list[float]:
    import torch
    import torch.nn.functional as F

    enc = _tokenizer.encode(text)
    ids = torch.tensor([enc.ids])
    mask = torch.tensor([enc.attention_mask])
    with torch.no_grad():
        hidden = _model(ids, mask)
        m = mask.float().unsqueeze(-1)
        pooled = (hidden * m).sum(1) / m.sum(1).clamp(min=1)
        pooled = F.normalize(pooled, p=2, dim=1)
    return pooled[0].tolist()


def _neural_embed_batch(texts: Sequence[str]) -> list[list[float]]:
    import torch
    import torch.nn.functional as F

    encs = _tokenizer.encode_batch(list(texts))
    ids = torch.tensor([e.ids for e in encs])
    mask = torch.tensor([e.attention_mask for e in encs])
    with torch.no_grad():
        hidden = _model(ids, mask)
        m = mask.float().unsqueeze(-1)
        pooled = (hidden * m).sum(1) / m.sum(1).clamp(min=1)
        pooled = F.normalize(pooled, p=2, dim=1)
    return pooled.tolist()


# ── Hash fallback (same as knowledge_base._embed) ────────────────────────────

import hashlib

_HASH_DIM = 384

_EN_RE = re.compile(r"[a-z0-9]+", re.IGNORECASE) if False else None  # lazy
import re as _re


def _hash_tokens(text: str) -> list[str]:
    text = (text or "").lower()
    tokens = list(_re.findall(r"[\u4e00-\u9fff]", text))
    for m in _re.findall(r"[a-z0-9]{2,}", text):
        tokens.append(m)
    return tokens


def _hash_embed(text: str) -> list[float]:
    vec = [0.0] * _HASH_DIM
    for tok in _hash_tokens(text):
        digest = hashlib.blake2b(tok.encode("utf-8"), digest_size=8).digest()
        raw = int.from_bytes(digest, "big")
        idx = raw % _HASH_DIM
        sign = -1.0 if raw & 1 else 1.0
        vec[idx] += sign
    norm = math.sqrt(sum(v * v for v in vec))
    if norm:
        vec = [round(v / norm, 6) for v in vec]
    return vec
