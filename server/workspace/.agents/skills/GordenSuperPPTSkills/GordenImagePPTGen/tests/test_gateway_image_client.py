import importlib.util
import json
import sys
import urllib.error
from pathlib import Path
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "generate_gateway_slide_image.py"


def load_client():
    spec = importlib.util.spec_from_file_location("generate_gateway_slide_image", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeGateway:
    def __init__(self):
        self.requests = []
        self.downloads = []

    def request_json(self, url, api_key, payload, timeout=300):
        self.requests.append((url, api_key, payload, timeout))
        if url.endswith("/v1/images/generations"):
            return {"code": 200, "task_id": "task-123"}
        if url.endswith("/v1/images/result"):
            return {"code": 200, "data": [{"url": "https://example.com/generated.png"}], "usage": {"image_count": 1}}
        raise AssertionError(f"unexpected URL: {url}")

    def download_url(self, url, output_path, timeout=300):
        self.downloads.append((url, output_path, timeout))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"png bytes")


def test_endpoint_from_base_url_normalizes_root_and_v1():
    client = load_client()

    assert client.endpoint_from_base_url("https://getways-jumu.zeelin.cn", "generations") == (
        "https://getways-jumu.zeelin.cn/v1/images/generations"
    )
    assert client.endpoint_from_base_url("https://getways-jumu.zeelin.cn/v1", "result") == (
        "https://getways-jumu.zeelin.cn/v1/images/result"
    )


def test_generate_image_creates_task_then_polls_result_and_saves_image(tmp_path):
    client = load_client()
    gateway = FakeGateway()

    result = client.generate_image(
        prompt="测试 PPT 页面",
        api_key="test-key",
        base_url="https://getways-jumu.zeelin.cn/v1",
        out_dir=tmp_path,
        model="gpt-image-2-reverse-2",
        size="2560x1440",
        quality="high",
        n=1,
        poll_interval=0,
        max_wait=1,
        request_json_func=gateway.request_json,
        download_url_func=gateway.download_url,
    )

    create_url, create_key, create_payload, _ = gateway.requests[0]
    result_url, result_key, result_payload, _ = gateway.requests[1]

    assert create_url == "https://getways-jumu.zeelin.cn/v1/images/generations"
    assert create_key == "test-key"
    assert create_payload == {
        "model": "gpt-image-2-reverse-2",
        "prompt": "测试 PPT 页面",
        "size": "2560x1440",
        "quality": "high",
        "n": 1,
        "watermark": False,
    }
    assert result_url == "https://getways-jumu.zeelin.cn/v1/images/result"
    assert result_key == "test-key"
    assert result_payload == {"model": "gpt-image-2-reverse-2", "task_id": "task-123"}
    assert gateway.downloads[0][0] == "https://example.com/generated.png"
    assert Path(result["saved"][0]).read_bytes() == b"png bytes"
    metadata = json.loads(Path(result["metadata_json"]).read_text(encoding="utf-8"))
    assert metadata["task_id"] == "task-123"
    assert metadata["status"] == "succeeded"


def test_poll_result_tolerates_transient_gateway_codes():
    client = load_client()
    responses = iter([
        {"code": 503, "message": "temporary unavailable"},
        {"code": 200, "data": [{"b64_json": "cG5n"}]},
    ])
    snapshots = []

    result = client.poll_result(
        "https://getways-jumu.zeelin.cn/v1/images/result",
        "test-key",
        "gpt-image-2-reverse-2",
        "task-456",
        poll_interval=0,
        max_wait=1,
        request_json_func=lambda *_args: next(responses),
        on_poll=snapshots.append,
    )

    assert result["code"] == 200
    assert [item["code"] for item in snapshots] == [503, 200]


def test_unicode_local_image_path_is_encoded_as_data_url(tmp_path):
    client = load_client()
    image_path = tmp_path / "智灵动力" / "模板封面.png"
    image_path.parent.mkdir(parents=True)
    image_path.write_bytes(b"not-a-real-png-but-valid-for-base64")

    normalized = client.normalize_image_input(str(image_path))

    assert normalized.startswith("data:image/png;base64,")


def test_download_url_retries_transient_ssl_url_errors(tmp_path):
    client = load_client()

    class FakeResponse:
        headers = {"Content-Type": "image/png"}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b"png bytes"

    responses = iter([
        urllib.error.URLError("SSL unexpected EOF"),
        FakeResponse(),
    ])

    def fake_urlopen(*_args, **_kwargs):
        response = next(responses)
        if isinstance(response, Exception):
            raise response
        return response

    output_path = tmp_path / "download.png"
    with patch.object(client.urllib.request, "urlopen", side_effect=fake_urlopen), patch.object(
        client.time,
        "sleep",
        return_value=None,
    ):
        client.download_url("https://example.com/generated.png", output_path, 1)

    assert output_path.read_bytes() == b"png bytes"


def test_download_url_falls_back_to_curl_after_urllib_ssl_failures(tmp_path):
    client = load_client()
    output_path = tmp_path / "download.png"

    def fake_curl(command, **_kwargs):
        output_index = command.index("--output") + 1
        Path(command[output_index]).write_bytes(b"curl png bytes")

    with patch.object(
        client.urllib.request,
        "urlopen",
        side_effect=urllib.error.URLError("SSL unexpected EOF"),
    ), patch.object(client.time, "sleep", return_value=None), patch.object(
        client.shutil,
        "which",
        return_value="/usr/bin/curl",
    ), patch.object(client.subprocess, "run", side_effect=fake_curl) as curl_run:
        client.download_url("https://example.com/generated.png", output_path, 1)

    assert curl_run.call_count == 1
    assert output_path.read_bytes() == b"curl png bytes"


def test_preflight_failure_writes_diagnostic_metadata(tmp_path):
    client = load_client()
    tmp_path.mkdir(parents=True, exist_ok=True)
    try:
        client.generate_image(
            prompt="测试中文路径诊断",
            api_key="test-key",
            base_url="https://getways-jumu.zeelin.cn/v1",
            out_dir=tmp_path,
            images=[str(tmp_path / "不存在的中文目录" / "模板.png")],
            poll_interval=0,
            max_wait=1,
        )
    except RuntimeError as error:
        assert "diagnostics:" in str(error)
    else:
        raise AssertionError("missing local image must fail before gateway request")

    metadata_files = list(tmp_path.glob("*.metadata.json"))
    assert len(metadata_files) == 1
    metadata = json.loads(metadata_files[0].read_text(encoding="utf-8"))
    assert metadata["status"] == "failed"
    assert "Image input does not exist" in metadata["error"]
