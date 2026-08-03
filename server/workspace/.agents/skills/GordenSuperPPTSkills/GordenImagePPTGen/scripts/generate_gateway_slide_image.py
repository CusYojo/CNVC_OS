#!/usr/bin/env python3
"""Generate PPT slide images through the user's async image gateway."""

from __future__ import annotations

import argparse
import base64
import binascii
import http.client
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional


DEFAULT_BASE_URL = "https://getways-jumu.zeelin.cn"
DEFAULT_MODEL = "gpt-image-2-reverse-2"
DEFAULT_SIZE = "2560x1440"
DEFAULT_QUALITY = "high"
DEFAULT_OUT_DIR = Path(".codex-run") / "GordenImagePPTGen" / "gateway-images"
API_KEY_ENV_NAMES = ("GATEWAY_IMAGE_API_KEY", "MODEL_GATEWAY_API_KEY", "OPENAI_API_KEY")
BASE_URL_ENV_NAMES = ("GATEWAY_IMAGE_BASE_URL", "MODEL_GATEWAY_BASE_URL", "OPENAI_BASE_URL")
RETRYABLE_HTTP_STATUS = {408, 425, 429, 500, 502, 503, 504}
MAX_REQUEST_ATTEMPTS = 4


class TransientGatewayError(RuntimeError):
    """A transport or retryable HTTP failure that may recover while polling."""


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def first_env(names: Iterable[str]) -> Optional[str]:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


def normalize_size(size: str) -> str:
    return size.strip().replace("×", "x").replace("\u200c", "").replace("\u200b", "")


def endpoint_from_base_url(base_url: str, endpoint: str) -> str:
    base = base_url.strip().rstrip("/")
    if base.endswith("/v1/images/generations") or base.endswith("/v1/images/result"):
        base = base.rsplit("/images/", 1)[0]
    if base.endswith("/v1"):
        return f"{base}/images/{endpoint}"
    return f"{base}/v1/images/{endpoint}"


def sanitize_error(text: str) -> str:
    text = re.sub(r"Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", text)
    return re.sub(r"(?i)(api[_-]?key|authorization|token)(['\"\s:=]+)[^,'\"\s}]+", r"\1\2[REDACTED]", text)


def request_json(url: str, api_key: str, payload: Dict[str, Any], timeout: int = 300) -> Dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    for attempt in range(1, MAX_REQUEST_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                response_body = resp.read().decode("utf-8", errors="replace")
            try:
                return json.loads(response_body)
            except json.JSONDecodeError as exc:
                if attempt < MAX_REQUEST_ATTEMPTS:
                    time.sleep(min(8.0, 2.0 ** (attempt - 1)))
                    continue
                raise TransientGatewayError(
                    f"Response was not JSON after {attempt} attempts: {response_body[:2000]}"
                ) from exc
        except urllib.error.HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            if exc.code in RETRYABLE_HTTP_STATUS:
                if attempt < MAX_REQUEST_ATTEMPTS:
                    time.sleep(min(8.0, 2.0 ** (attempt - 1)))
                    continue
                raise TransientGatewayError(
                    f"HTTP {exc.code} after {attempt} attempts: {sanitize_error(error_body)[:2000]}"
                ) from exc
            raise RuntimeError(f"HTTP {exc.code}: {sanitize_error(error_body)[:2000]}") from exc
        except (
            urllib.error.URLError,
            http.client.HTTPException,
            TimeoutError,
            ConnectionError,
            OSError,
        ) as exc:
            if attempt < MAX_REQUEST_ATTEMPTS:
                time.sleep(min(8.0, 2.0 ** (attempt - 1)))
                continue
            raise TransientGatewayError(
                f"Request failed after {attempt} attempts: {sanitize_error(str(exc))}"
            ) from exc
    raise TransientGatewayError("Request failed without a gateway response")


def data_url_from_file(path_text: str) -> str:
    path = Path(path_text).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"Image input does not exist: {path}")
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def normalize_image_input(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme in {"http", "https", "data"}:
        return value
    # Long absolute paths were previously tested as raw Base64 first. A path that
    # contains CJK characters then raises UnicodeEncodeError before it can be read.
    # Resolve an existing local file before considering the raw-Base64 fallback.
    local_path = Path(value).expanduser()
    if local_path.exists():
        return data_url_from_file(value)
    compact = "".join(value.split())
    if len(compact) > 128:
        try:
            base64.b64decode(compact, validate=True)
            return compact
        except (binascii.Error, UnicodeEncodeError, ValueError):
            pass
    return data_url_from_file(value)


def build_create_payload(
    prompt: str,
    model: str,
    size: str,
    quality: str,
    n: int,
    images: Optional[List[str]] = None,
    bypass: Optional[Dict[str, Any]] = None,
    watermark: bool = False,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "size": normalize_size(size),
        "quality": quality,
        "n": n,
        "watermark": watermark,
    }
    if images:
        payload["images"] = [normalize_image_input(image) for image in images]
    if bypass is not None:
        payload["byPass"] = bypass
    return payload


def extract_task_id(response: Dict[str, Any]) -> Optional[str]:
    if response.get("task_id"):
        return str(response["task_id"])
    data = response.get("data")
    if isinstance(data, dict) and data.get("task_id"):
        return str(data["task_id"])
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and item.get("task_id"):
                return str(item["task_id"])
    return None


def response_has_images(response: Dict[str, Any]) -> bool:
    data = response.get("data")
    return isinstance(data, list) and any(isinstance(item, dict) and (item.get("url") or item.get("b64_json")) for item in data)


def extension_from_content_type(content_type: Optional[str], fallback: str) -> str:
    if content_type:
        content_type = content_type.split(";", 1)[0].strip().lower()
        if content_type == "image/jpeg":
            return ".jpg"
        if content_type == "image/png":
            return ".png"
        if content_type == "image/webp":
            return ".webp"
    suffix = Path(urllib.parse.urlparse(fallback).path).suffix
    if suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
        return suffix
    return ".png"


def safe_stem(prompt: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", prompt.strip())[:48].strip("-._")
    return stem or "slide"


def download_url(url: str, output_path: Path, timeout: int = 300) -> None:
    content_type: Optional[str] = None
    data = b""
    urllib_error: Optional[Exception] = None
    for attempt in range(1, MAX_REQUEST_ATTEMPTS + 1):
        req = urllib.request.Request(url, headers={"User-Agent": "Codex GordenImagePPTGen"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                content_type = resp.headers.get("Content-Type")
                data = resp.read()
            if not data:
                raise RuntimeError("Downloaded image was empty")
            break
        except (urllib.error.URLError, OSError, RuntimeError) as exc:
            urllib_error = exc
            if attempt >= MAX_REQUEST_ATTEMPTS:
                break
            time.sleep(min(8.0, 2.0 ** (attempt - 1)))
    final_path = output_path
    if output_path.suffix == ".tmp":
        final_path = output_path.with_suffix(extension_from_content_type(content_type, url))
    final_path.parent.mkdir(parents=True, exist_ok=True)
    if data:
        final_path.write_bytes(data)
        return

    curl = shutil.which("curl")
    if curl:
        try:
            subprocess.run(
                [
                    curl,
                    "--fail",
                    "--location",
                    "--silent",
                    "--show-error",
                    "--retry",
                    str(MAX_REQUEST_ATTEMPTS),
                    "--retry-all-errors",
                    "--connect-timeout",
                    "30",
                    "--max-time",
                    str(timeout),
                    "--user-agent",
                    "Codex GordenImagePPTGen",
                    "--output",
                    str(final_path),
                    url,
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=timeout + 30,
            )
            if final_path.exists() and final_path.stat().st_size > 0:
                return
            raise RuntimeError("curl downloaded an empty image")
        except (OSError, subprocess.SubprocessError, RuntimeError) as curl_error:
            final_path.unlink(missing_ok=True)
            curl_detail = getattr(curl_error, "stderr", "") or type(curl_error).__name__
            raise RuntimeError(
                "Image download failed with urllib and curl fallback: "
                f"urllib={urllib_error}; curl={sanitize_error(str(curl_detail))[:1000]}"
            ) from curl_error

    raise RuntimeError(
        f"Image download failed after {MAX_REQUEST_ATTEMPTS} urllib attempts: {urllib_error}"
    ) from urllib_error


def write_b64_image(b64_text: str, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(base64.b64decode(b64_text))


def save_images(
    response: Dict[str, Any],
    out_dir: Path,
    stem: str,
    download_url_func: Callable[[str, Path, int], None] = download_url,
) -> List[str]:
    saved: List[str] = []
    data = response.get("data") or []
    for index, item in enumerate(data, start=1):
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        b64_json = item.get("b64_json")
        if url:
            ext = extension_from_content_type(None, str(url))
            output_path = out_dir / f"{stem}-{index}{ext}"
            download_url_func(str(url), output_path, 300)
            saved.append(str(output_path.resolve()))
        elif b64_json:
            output_path = out_dir / f"{stem}-{index}.png"
            write_b64_image(str(b64_json), output_path)
            saved.append(str(output_path.resolve()))
    return saved


def poll_result(
    result_url: str,
    api_key: str,
    model: str,
    task_id: str,
    poll_interval: float,
    max_wait: float,
    request_json_func: Callable[[str, str, Dict[str, Any], int], Dict[str, Any]] = request_json,
    on_poll: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    started = time.monotonic()
    last_response: Dict[str, Any] = {}
    while True:
        try:
            last_response = request_json_func(
                result_url,
                api_key,
                {"model": model, "task_id": task_id},
                300,
            )
        except TransientGatewayError as exc:
            transport_snapshot = {
                "code": "transport_retry",
                "message": sanitize_error(str(exc))[:2000],
                "task_id": task_id,
            }
            if on_poll is not None:
                on_poll(transport_snapshot)
            if time.monotonic() - started >= max_wait:
                raise TimeoutError(
                    f"Timed out waiting for image task {task_id} after transient transport errors. "
                    f"Last error: {transport_snapshot['message']}"
                ) from exc
            if poll_interval > 0:
                time.sleep(poll_interval)
            continue
        if on_poll is not None:
            on_poll(last_response)
        code = last_response.get("code")
        if code in RETRYABLE_HTTP_STATUS:
            if time.monotonic() - started >= max_wait:
                raise TimeoutError(
                    f"Timed out waiting for image task {task_id} after transient gateway errors. "
                    f"Last response: {sanitize_error(json.dumps(last_response, ensure_ascii=False))[:2000]}"
                )
            if poll_interval > 0:
                time.sleep(poll_interval)
            continue
        if code not in (None, 200, 202):
            raise RuntimeError(f"Gateway result returned code {code}: {sanitize_error(json.dumps(last_response, ensure_ascii=False))[:2000]}")
        if response_has_images(last_response):
            return last_response
        if time.monotonic() - started >= max_wait:
            raise TimeoutError(f"Timed out waiting for image task {task_id}. Last response: {sanitize_error(json.dumps(last_response, ensure_ascii=False))[:2000]}")
        if poll_interval > 0:
            time.sleep(poll_interval)


def generate_image(
    prompt: str,
    api_key: str,
    base_url: str,
    out_dir: Path,
    model: str = DEFAULT_MODEL,
    size: str = DEFAULT_SIZE,
    quality: str = DEFAULT_QUALITY,
    n: int = 1,
    images: Optional[List[str]] = None,
    bypass: Optional[Dict[str, Any]] = None,
    watermark: bool = False,
    resume_task_id: Optional[str] = None,
    poll_interval: float = 5.0,
    max_wait: float = 180.0,
    request_json_func: Callable[[str, str, Dict[str, Any], int], Dict[str, Any]] = request_json,
    download_url_func: Callable[[str, Path, int], None] = download_url,
) -> Dict[str, Any]:
    create_url = endpoint_from_base_url(base_url, "generations")
    result_url = endpoint_from_base_url(base_url, "result")
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{timestamp}-{safe_stem(prompt)}"
    metadata_path = out_dir / f"{stem}.metadata.json"
    metadata = {
        "status": "preparing",
        "task_id": None,
        "create_endpoint": create_url,
        "result_endpoint": result_url,
        "create_payload": None,
        "create_response": None,
        "last_result_response": None,
        "resumed_task_id": resume_task_id,
        "saved": [],
        "usage": None,
    }
    def persist_metadata() -> None:
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")

    persist_metadata()
    try:
        payload = build_create_payload(
            prompt,
            model,
            size,
            quality,
            n,
            images=images,
            bypass=bypass,
            watermark=watermark,
        )
        metadata_payload = dict(payload)
        if metadata_payload.get("images"):
            metadata_payload["images"] = [
                f"[reference-image-{index}]"
                for index, _value in enumerate(metadata_payload["images"], start=1)
            ]
        metadata["create_payload"] = metadata_payload
        metadata["status"] = "creating"
        persist_metadata()
        if resume_task_id:
            task_id = resume_task_id
            create_response = {"resumed": True, "task_id": task_id}
        else:
            create_response = request_json_func(create_url, api_key, payload, 300)
            if create_response.get("code") not in (None, 200):
                raise RuntimeError(f"Gateway create returned code {create_response.get('code')}: {sanitize_error(json.dumps(create_response, ensure_ascii=False))[:2000]}")
            task_id = extract_task_id(create_response)
            if not task_id:
                raise RuntimeError(f"Gateway create response did not include task_id: {sanitize_error(json.dumps(create_response, ensure_ascii=False))[:2000]}")
        metadata["create_response"] = create_response
        metadata["task_id"] = task_id
        metadata["status"] = "polling"
        persist_metadata()

        def capture_poll(response: Dict[str, Any]) -> None:
            metadata["last_result_response"] = response
            persist_metadata()

        result_response = poll_result(
            result_url,
            api_key,
            model,
            task_id,
            poll_interval,
            max_wait,
            request_json_func=request_json_func,
            on_poll=capture_poll,
        )
        saved = save_images(result_response, out_dir, stem, download_url_func=download_url_func)
        metadata.update({
            "status": "succeeded",
            "result_response": result_response,
            "saved": saved,
            "usage": result_response.get("usage"),
        })
        persist_metadata()
    except Exception as exc:
        metadata["status"] = "failed"
        metadata["error"] = sanitize_error(str(exc))[:4000]
        persist_metadata()
        raise RuntimeError(f"{exc} (diagnostics: {metadata_path.resolve()})") from exc
    return {
        "task_id": task_id,
        "model": model,
        "size": payload["size"],
        "quality": quality,
        "n": n,
        "saved": saved,
        "metadata_json": str(metadata_path.resolve()),
        "usage": result_response.get("usage"),
    }


def parse_bypass(value: Optional[str]) -> Optional[Dict[str, Any]]:
    if value is None or value == "":
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(f"--bypass must be valid JSON: {exc}") from exc
    if parsed is None:
        return None
    if not isinstance(parsed, dict):
        raise argparse.ArgumentTypeError("--bypass must be a JSON object or null")
    return parsed


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate PPT slide images through the async gateway.")
    parser.add_argument("--prompt", required=True, help="Image prompt, or @path to read a UTF-8 prompt file.")
    parser.add_argument("--image", action="append", help="Optional source image URL/data URL/base64/local path for image edit.")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--size", default=DEFAULT_SIZE, help="Image size, for example 2560x1440. Chinese × is normalized to x.")
    parser.add_argument("--quality", default=DEFAULT_QUALITY, choices=["low", "medium", "high"])
    parser.add_argument("--n", type=int, default=1)
    parser.add_argument("--bypass", type=parse_bypass, default=None, help="Optional JSON object passed as byPass. Use 'null' to omit.")
    parser.add_argument("--watermark", action="store_true", help="Set watermark=true. Default is false.")
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--base-url", help=f"Gateway root or /v1 URL. Default env or {DEFAULT_BASE_URL}.")
    parser.add_argument("--api-key", help="API key. Prefer environment variables; do not hard-code in files.")
    parser.add_argument("--dotenv", default=".env")
    parser.add_argument("--poll-interval", type=float, default=5.0)
    parser.add_argument("--max-wait", type=float, default=180.0)
    parser.add_argument("--resume-task-id", help="Poll an existing gateway task instead of creating a duplicate task.")
    parser.add_argument("--dry-run", action="store_true", help="Print create/result endpoints and payload without calling the gateway.")
    args = parser.parse_args(argv)
    if not 1 <= args.n <= 10:
        parser.error("--n must be between 1 and 10")
    if args.poll_interval < 0:
        parser.error("--poll-interval must be >= 0")
    if args.max_wait <= 0:
        parser.error("--max-wait must be > 0")
    return args


def prompt_from_arg(value: str) -> str:
    if value.startswith("@"):
        return Path(value[1:]).read_text(encoding="utf-8")
    return value


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    load_dotenv(Path(args.dotenv))
    prompt = prompt_from_arg(args.prompt)
    api_key = args.api_key or first_env(API_KEY_ENV_NAMES)
    base_url = args.base_url or first_env(BASE_URL_ENV_NAMES) or DEFAULT_BASE_URL
    if not api_key:
        print("Missing API key. Set GATEWAY_IMAGE_API_KEY, MODEL_GATEWAY_API_KEY, OPENAI_API_KEY, or pass --api-key.", file=sys.stderr)
        return 2

    if args.dry_run:
        payload = build_create_payload(
            prompt,
            args.model,
            args.size,
            args.quality,
            args.n,
            images=args.image,
            bypass=args.bypass,
            watermark=args.watermark,
        )
        print(json.dumps({
            "create_endpoint": endpoint_from_base_url(base_url, "generations"),
            "result_endpoint": endpoint_from_base_url(base_url, "result"),
            "create_payload": payload,
        }, ensure_ascii=False, indent=2))
        return 0

    result = generate_image(
        prompt=prompt,
        api_key=api_key,
        base_url=base_url,
        out_dir=Path(args.out_dir),
        model=args.model,
        size=args.size,
        quality=args.quality,
        n=args.n,
        images=args.image,
        bypass=args.bypass,
        watermark=args.watermark,
        resume_task_id=args.resume_task_id,
        poll_interval=args.poll_interval,
        max_wait=args.max_wait,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result["saved"]:
        print("No image URL or b64_json found in final result data.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
