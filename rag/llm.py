"""LLMクライアント。測定はローカル（Ollama）、本番はClaudeを想定する。

パイプライン側（pipeline.py）はこのモジュールの具象実装に依存しない。
測定用のローカルモデルと本番モデルを差し替えても、プロンプトと段構成は変わらない。
"""

from __future__ import annotations

import json
import re
import os
import urllib.request
from typing import Any

OLLAMA_ENDPOINT = "http://localhost:11434/api/generate"
DEFAULT_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:30b-a3b")
NUM_CTX = 32768

# think=false を指定しても qwen3 は思考を本文に混ぜてくることがある。
# 本番のClaudeでは thinking ブロックが構造として分離されるため不要になるが、
# ローカル測定では後処理で落とさないと、回答評価が思考文まで採点してしまう。
THINK_BLOCK = re.compile(r"<think>.*?</think>", re.S | re.I)
THINK_TAIL = re.compile(r"^.*?</think>\s*", re.S | re.I)


def strip_thinking(text: str) -> str:
    text = THINK_BLOCK.sub("", text)
    if "</think>" in text.lower():  # 開始タグが欠けた壊れ方をすることがある
        text = THINK_TAIL.sub("", text)
    return text.strip()


class OllamaLLM:
    """ローカル測定用。非公開Wikiのデータを外部に出さないために使う。

    プロンプトの先頭に置かれた固定部分（目次）はKVキャッシュで再利用されるため、
    2回目以降のプロンプト処理が 80秒 → 0.8秒 になる（M2aで実測）。
    呼び出し側は目次を必ず先頭に置くこと。
    """

    def __init__(self, model: str = DEFAULT_MODEL, timeout: int = 900):
        self.model = model
        self.timeout = timeout
        self.calls = 0
        self.seconds = 0.0

    def __call__(self, prompt: str, schema: dict | None = None, max_tokens: int = 800) -> Any:
        import time

        # qwen3 のソフトスイッチ。API の think=false だけでは
        # 閉じタグの無い思考文が本文に混ざることが M2b で分かった
        prompt = prompt + "\n/no_think"
        payload: dict[str, Any] = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "think": False,  # 思考トークンで出力を使い切るのを防ぐ
            "options": {"num_ctx": NUM_CTX, "temperature": 0, "num_predict": max_tokens},
        }
        if schema:
            payload["format"] = schema

        started = time.time()
        request = urllib.request.Request(
            OLLAMA_ENDPOINT, json.dumps(payload).encode(), {"Content-Type": "application/json"}
        )
        response = json.load(urllib.request.urlopen(request, timeout=self.timeout))
        self.calls += 1
        self.seconds += time.time() - started

        text = strip_thinking(response.get("response", ""))
        if not schema:
            return text
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # スキーマを指定しても壊れることがある。呼び出し側が既定値で処理する
            return {}
