#!/usr/bin/env python3
"""Cherry-owned DeepSeek Harness SDK peer.

stdin:  NDJSON {op, sessionId, text, cwd, model}
stdout: NDJSON {kind, ...}  — stdout is the protocol
stderr: diagnostics
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any

from deepseek_harness import DeepSeekHarness, DeepSeekHarnessConfig


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    sys.stderr.write(message.rstrip() + "\n")
    sys.stderr.flush()


class Runner:
    def __init__(self) -> None:
        self.harness: DeepSeekHarness | None = None
        self.cwd: str | None = None
        self.model: str | None = None
        self.provider: str = os.environ.get("DSH_PROVIDER", "deepseek-official")

    def ensure(self, cwd: str, model: str) -> DeepSeekHarness:
        cwd = str(Path(cwd).resolve())
        if self.harness is not None and self.cwd == cwd and self.model == model:
            return self.harness
        self.close()
        session_root = os.environ.get("DSH_SESSION_ROOT") or str(Path.cwd() / ".dsh-sessions")
        Path(session_root).mkdir(parents=True, exist_ok=True)
        config = DeepSeekHarnessConfig(
            provider=self.provider,
            model=model,
            cwd=cwd,
            session_root=session_root,
            api_key=os.environ.get("DEEPSEEK_API_KEY"),
            base_url=os.environ.get("DEEPSEEK_BASE_URL") or None,
        )
        harness = DeepSeekHarness(config)
        harness.start()
        self.harness = harness
        self.cwd = cwd
        self.model = model
        log(f"harness ready provider={self.provider} model={model} cwd={cwd}")
        return harness

    def prompt(self, command: dict[str, Any]) -> None:
        session_id = str(command.get("sessionId") or "session")
        text = str(command.get("text") or "").strip()
        cwd = str(command.get("cwd") or os.getcwd())
        model = str(command.get("model") or os.environ.get("DSH_MODEL") or "deepseek-v4-flash")
        if not text:
            emit({"kind": "error", "sessionId": session_id, "message": "empty prompt"})
            return
        harness = self.ensure(cwd, model)

        def on_notification(notification: Any) -> None:
            method = getattr(notification, "method", None)
            payload = getattr(notification, "payload", {}) or {}
            if method == "session.event":
                emit(
                    {
                        "kind": "session-event",
                        "sessionId": payload.get("sessionId") or session_id,
                        "event": payload.get("event"),
                    }
                )
                return
            if method == "session.status":
                emit(
                    {
                        "kind": "status",
                        "sessionId": payload.get("sessionId") or session_id,
                        "status": payload.get("status"),
                    }
                )

        result = harness.run(text, session_id=session_id, on_notification=on_notification)
        emit(
            {
                "kind": "result",
                "sessionId": result.session_id,
                "finalResponse": result.final_response,
                "finishReason": result.finish_reason,
                "errorMessage": turn_error_message(result.events),
            }
        )

    def close(self) -> None:
        if self.harness is None:
            return
        try:
            self.harness.close()
        except Exception as error:  # noqa: BLE001
            log(f"harness close failed: {error}")
        self.harness = None


def turn_error_message(events: list[Any]) -> str | None:
    for event in reversed(events):
        if not isinstance(event, dict) or event.get("type") != "turn/end":
            continue
        data = event.get("data")
        reason = data.get("reason") if isinstance(data, dict) else None
        if not isinstance(reason, dict) or reason.get("kind") != "error":
            return None
        source = reason.get("error") or reason.get("failure")
        if isinstance(source, dict):
            message = str(source.get("message") or "").strip()
            code = str(source.get("code") or "").strip()
            if message and code and code not in message:
                return f"{message} ({code})"
            return message or code or None
        if isinstance(source, str) and source.strip():
            return source.strip()
        return None
    return None


def main() -> int:
    if not os.environ.get("DEEPSEEK_API_KEY"):
        emit({"kind": "error", "message": "DEEPSEEK_API_KEY is not set"})
        return 2
    runner = Runner()
    emit({"kind": "ready"})
    try:
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            try:
                command = json.loads(line)
            except json.JSONDecodeError as error:
                emit({"kind": "error", "message": f"invalid json: {error}"})
                continue
            op = command.get("op")
            if op == "shutdown":
                break
            if op == "prompt":
                try:
                    runner.prompt(command)
                except Exception as error:  # noqa: BLE001
                    traceback.print_exc(file=sys.stderr)
                    emit({"kind": "error", "sessionId": command.get("sessionId"), "message": str(error)})
                continue
            emit({"kind": "error", "message": f"unknown op: {op}"})
    finally:
        runner.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
