import importlib.util
import json
import sys
from pathlib import Path


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
    assert json.loads(Path(result["metadata_json"]).read_text(encoding="utf-8"))["task_id"] == "task-123"
