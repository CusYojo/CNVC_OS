#!/usr/bin/env python3

import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_ROOT / "scripts"))

from deta_ic_processor import (  # noqa: E402
    APPROVED_TEMPLATE_SHA256,
    render_proposal,
    validate_approved_template,
)


def main() -> None:
    template = PLUGIN_ROOT / "assets" / "德塔式精简工商字段投资提案_固定模板V7.docx"
    assert validate_approved_template(template) == APPROVED_TEMPLATE_SHA256

    with tempfile.TemporaryDirectory(prefix="sbl-template-test-") as temp_dir:
        temp = Path(temp_dir)
        proposal = temp / "proposal.json"
        output = temp / "output.docx"
        proposal.write_text(
            json.dumps(
                {
                    "meta": {
                        "title_lines": ["关于测试投资主体", "对测试公司实施股权投资的提案"],
                        "signature_entity": "测试投资主体",
                        "date": "2026年8月",
                    },
                    "sections": [{"title": "一、基本情况简介", "paragraphs": ["模板克隆测试。"]}],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        used_sha256 = render_proposal(proposal, output, template)
        assert used_sha256 == APPROVED_TEMPLATE_SHA256
        assert output.is_file() and zipfile.is_zipfile(output)
        with zipfile.ZipFile(template) as source, zipfile.ZipFile(output) as generated:
            assert source.read("word/theme/theme1.xml") == generated.read("word/theme/theme1.xml")
            assert any(name.startswith("word/footer") for name in generated.namelist())

        altered = temp / "altered.docx"
        shutil.copy2(template, altered)
        with altered.open("ab") as stream:
            stream.write(b"template-drift")
        try:
            validate_approved_template(altered)
        except SystemExit as exc:
            assert "fingerprint mismatch" in str(exc)
        else:
            raise AssertionError("altered template must fail the hard gate")

    print("template enforcement tests passed")


if __name__ == "__main__":
    main()
